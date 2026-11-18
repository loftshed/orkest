import AppKit
import Darwin
import QuartzCore

// Floating macOS AppKit HUD toast presenter for Orkest completion and approval alerts.
// Supports `--dump-card` for headless JSON card normalization without initializing AppKit/WindowServer.

private struct HudTarget: Codable, Equatable {
    let kind: String
    let id: String
    let bin: String?
}

private struct HudPayload: Codable {
    let title: String?
    let subtitle: String?
    let body: String?
    let status: String?
    let repo: String?
    let agent: String?
    let sound: String?
    let durationSeconds: Double?
    let target: HudTarget?
}

private struct HudCard: Codable {
    let badge: String
    let accentHex: String
    let header: String
    let title: String
    let body: String
    let actionHint: String
    let durationSeconds: Double
    let target: HudTarget?

    enum CodingKeys: String, CodingKey {
        case badge
        case accentHex
        case header
        case title
        case body
        case actionHint
        case durationSeconds
        case target
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(badge, forKey: .badge)
        try container.encode(accentHex, forKey: .accentHex)
        try container.encode(header, forKey: .header)
        try container.encode(title, forKey: .title)
        try container.encode(body, forKey: .body)
        try container.encode(actionHint, forKey: .actionHint)
        try container.encode(durationSeconds, forKey: .durationSeconds)
        if let target {
            try container.encode(target, forKey: .target)
        } else {
            try container.encodeNil(forKey: .target)
        }
    }
}

private struct NormalizedRequest {
    let card: HudCard
    let status: String
    let sound: String
    let normalizedJson: String
}

private struct CliOptions {
    let jsonText: String
    let dumpCard: Bool
    let foreground: Bool
}

private struct StatusStyle {
    let status: String
    let badge: String
    let accentHex: String
    let defaultDuration: Double
    let defaultSound: String
}

private func nonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
        return nil
    }
    return trimmed
}

private func styleForStatus(_ raw: String?) -> StatusStyle {
    let normalized = nonEmpty(raw)?.lowercased() ?? "info"
    switch normalized {
    case "done":
        return StatusStyle(status: "done", badge: "DONE", accentHex: "#10B981", defaultDuration: 5.0, defaultSound: "done")
    case "blocked":
        return StatusStyle(status: "blocked", badge: "BLOCKED", accentHex: "#F59E0B", defaultDuration: 7.0, defaultSound: "request")
    case "approval":
        return StatusStyle(status: "approval", badge: "APPROVAL", accentHex: "#F59E0B", defaultDuration: 7.0, defaultSound: "request")
    case "failed":
        return StatusStyle(status: "failed", badge: "FAILED", accentHex: "#F43F5E", defaultDuration: 5.0, defaultSound: "request")
    default:
        return StatusStyle(status: "info", badge: "INFO", accentHex: "#38BDF8", defaultDuration: 5.0, defaultSound: "none")
    }
}

private func normalizeTarget(_ raw: HudTarget?) -> HudTarget? {
    guard let raw else { return nil }
    let kind = raw.kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard kind == "herdr" || kind == "orca" else { return nil }
    let id = raw.id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !id.isEmpty, !id.hasPrefix("-"), id.rangeOfCharacter(from: .controlCharacters) == nil else {
        return nil
    }
    let bin = nonEmpty(raw.bin)
    if let bin, bin.rangeOfCharacter(from: .controlCharacters) != nil {
        return nil
    }
    return HudTarget(kind: kind, id: id, bin: bin)
}

private func normalizeSound(_ raw: String?, fallback: String) -> String {
    guard let value = nonEmpty(raw)?.lowercased() else { return fallback }
    switch value {
    case "done", "request", "none":
        return value
    default:
        return fallback
    }
}

private func parseCliOptions(_ arguments: [String]) throws -> CliOptions {
    var jsonArg: String?
    var readStdin = false
    var dumpCard = false
    var foreground = false

    var index = 1
    while index < arguments.count {
        let arg = arguments[index]
        switch arg {
        case "--json":
            guard index + 1 < arguments.count else {
                throw NSError(domain: "OrkestHUD", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing value after --json"])
            }
            jsonArg = arguments[index + 1]
            index += 2
        case "--stdin-json":
            readStdin = true
            index += 1
        case "--dump-card":
            dumpCard = true
            index += 1
        case "--foreground":
            foreground = true
            index += 1
        default:
            throw NSError(domain: "OrkestHUD", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unknown argument: \(arg)"])
        }
    }

    let rawJson: String
    if let jsonArg {
        rawJson = jsonArg
    } else if readStdin {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        guard let text = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "OrkestHUD", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid UTF-8 on stdin"])
        }
        rawJson = text
    } else {
        throw NSError(domain: "OrkestHUD", code: 2, userInfo: [NSLocalizedDescriptionKey: "Expected --json <json> or --stdin-json"])
    }

    return CliOptions(jsonText: rawJson, dumpCard: dumpCard, foreground: foreground)
}

private func buildRequest(from jsonText: String) throws -> NormalizedRequest {
    guard let data = jsonText.data(using: .utf8) else {
        throw NSError(domain: "OrkestHUD", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid UTF-8 JSON"])
    }
    let payload = try JSONDecoder().decode(HudPayload.self, from: data)
    let style = styleForStatus(payload.status)
    let repo = nonEmpty(payload.repo)
    let agent = nonEmpty(payload.agent)
    let header = (["Orkest", repo, agent].compactMap { $0 }).joined(separator: " · ")

    let rawTitle = nonEmpty(payload.title)
    let rawSubtitle = nonEmpty(payload.subtitle)
    let rawBody = nonEmpty(payload.body)
    guard rawTitle != nil || rawSubtitle != nil || rawBody != nil else {
        throw NSError(domain: "OrkestHUD", code: 2, userInfo: [NSLocalizedDescriptionKey: "Payload requires title or body"])
    }

    let title = rawTitle ?? "Orkest"
    let body: String
    if let rawSubtitle, let rawBody {
        body = "\(rawSubtitle)\n\(rawBody)"
    } else {
        body = rawBody ?? rawSubtitle ?? ""
    }

    let target = normalizeTarget(payload.target)
    let actionHint = target == nil ? "" : "Click to focus pane"
    let duration: Double
    if let provided = payload.durationSeconds, provided.isFinite, provided > 0 {
        duration = provided
    } else {
        duration = style.defaultDuration
    }
    let sound = normalizeSound(payload.sound, fallback: style.defaultSound)

    let card = HudCard(
        badge: style.badge,
        accentHex: style.accentHex,
        header: header,
        title: title,
        body: body,
        actionHint: actionHint,
        durationSeconds: duration,
        target: target
    )

    let normalizedPayload = HudPayload(
        title: title,
        subtitle: nil,
        body: body,
        status: style.status,
        repo: repo,
        agent: agent,
        sound: sound,
        durationSeconds: duration,
        target: target
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let normalizedData = try encoder.encode(normalizedPayload)
    let normalizedJson = String(data: normalizedData, encoding: .utf8) ?? "{}"

    return NormalizedRequest(card: card, status: style.status, sound: sound, normalizedJson: normalizedJson)
}

private func writeStderr(_ message: String) {
    if let data = "\(message)\n".data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

private func resolveSelfExecutableURL() -> URL {
    let arg0 = CommandLine.arguments.first ?? "OrkestHUD"
    if arg0.hasPrefix("/") {
        return URL(fileURLWithPath: arg0)
    }
    if let bundleExe = Bundle.main.executableURL {
        return bundleExe
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(arg0)
}

private func spawnDetachedForeground(normalizedJson: String) throws {
    let process = Process()
    process.executableURL = resolveSelfExecutableURL()
    process.arguments = ["--foreground", "--json", normalizedJson]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
}

// MARK: - Slot Coordination

private struct SlotEntry: Codable {
    let slot: Int
    let pid: Int32
    let height: Double
    let expiresAt: Double
}

private final class SlotCoordinator {
    private static let slotsURL = FileManager.default.temporaryDirectory.appendingPathComponent("orkest-hud-slots.json")
    private static let lockURL = FileManager.default.temporaryDirectory.appendingPathComponent("orkest-hud-slots.lock")
    private let pid = ProcessInfo.processInfo.processIdentifier

    private func withLock<T>(_ work: () -> T) -> T {
        let fd = Darwin.open(SlotCoordinator.lockURL.path, O_CREAT | O_RDWR, 0o600)
        var lock = Darwin.flock()
        if fd >= 0 {
            lock.l_type = Int16(F_WRLCK)
            lock.l_whence = Int16(SEEK_SET)
            _ = Darwin.fcntl(fd, F_SETLKW, &lock)
        }
        defer {
            if fd >= 0 {
                lock.l_type = Int16(F_UNLCK)
                _ = Darwin.fcntl(fd, F_SETLKW, &lock)
                Darwin.close(fd)
            }
        }
        return work()
    }

    private func isProcessAlive(_ targetPid: Int32) -> Bool {
        guard targetPid > 0 else { return false }
        if Darwin.kill(targetPid, 0) == 0 {
            return true
        }
        return errno != ESRCH
    }

    private func readSlots() -> [SlotEntry] {
        guard let data = try? Data(contentsOf: SlotCoordinator.slotsURL),
              let decoded = try? JSONDecoder().decode([SlotEntry].self, from: data) else {
            return []
        }
        return decoded
    }

    private func writeSlots(_ entries: [SlotEntry]) {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? data.write(to: SlotCoordinator.slotsURL, options: .atomic)
    }

    func acquire(height: CGFloat, durationSeconds: Double) -> CGFloat {
        withLock {
            let now = Date().timeIntervalSince1970
            let active = readSlots().filter { entry in
                entry.pid != pid && entry.expiresAt > now && isProcessAlive(entry.pid)
            }
            let used = Set(active.map { $0.slot })
            var chosen = 0
            while used.contains(chosen) && chosen < 6 {
                chosen += 1
            }
            if chosen >= 6 {
                chosen = 0
            }

            var yOffset: CGFloat = 0
            for idx in 0..<chosen {
                let slotHeight = active.first(where: { $0.slot == idx })?.height ?? Double(height)
                yOffset += CGFloat(slotHeight) + 10.0
            }

            let entry = SlotEntry(
                slot: chosen,
                pid: pid,
                height: Double(height),
                expiresAt: now + durationSeconds + 10.0
            )
            writeSlots(active + [entry])
            return yOffset
        }
    }

    func release() {
        withLock {
            let remaining = readSlots().filter { $0.pid != pid }
            writeSlots(remaining)
        }
    }
}

// MARK: - AppKit Presentation

private func colorFromHex(_ hex: String) -> NSColor {
    let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var rgb: UInt64 = 0
    Scanner(string: cleaned).scanHexInt64(&rgb)
    let red = CGFloat((rgb >> 16) & 0xFF) / 255.0
    let green = CGFloat((rgb >> 8) & 0xFF) / 255.0
    let blue = CGFloat(rgb & 0xFF) / 255.0
    return NSColor(srgbRed: red, green: green, blue: blue, alpha: 1.0)
}

private func resolveExecutable(_ command: String, env: [String: String]) -> URL? {
    let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let fm = FileManager.default
    if trimmed.contains("/") {
        let expanded = (trimmed as NSString).expandingTildeInPath
        return fm.isExecutableFile(atPath: expanded) ? URL(fileURLWithPath: expanded) : nil
    }
    let home = NSHomeDirectory()
    var searchDirs = (env["PATH"] ?? "")
        .split(separator: ":")
        .map(String.init)
    searchDirs.append(contentsOf: ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])
    for dir in searchDirs where !dir.isEmpty {
        let candidate = URL(fileURLWithPath: dir).appendingPathComponent(trimmed).path
        if fm.isExecutableFile(atPath: candidate) {
            return URL(fileURLWithPath: candidate)
        }
    }
    return nil
}

private func focusTarget(_ target: HudTarget, completion: @escaping () -> Void) {
    let env = ProcessInfo.processInfo.environment
    let defaultBin: String
    let arguments: [String]
    switch target.kind {
    case "herdr":
        defaultBin = nonEmpty(env["HERDR_BIN_PATH"]) ?? "herdr"
        arguments = ["agent", "focus", target.id]
    case "orca":
        defaultBin = nonEmpty(env["ORCA_CLI_COMMAND"]) ?? "orca"
        arguments = ["terminal", "switch", "--terminal", target.id, "--json"]
    default:
        completion()
        return
    }

    let candidateBin = target.bin ?? defaultBin
    guard let executableURL = resolveExecutable(candidateBin, env: env) else {
        completion()
        return
    }

    DispatchQueue.global(qos: .userInitiated).async {
        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        process.environment = env
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .utility).async {
                process.waitUntilExit()
                done.signal()
            }
            if done.wait(timeout: .now() + 2.0) == .timedOut, process.isRunning {
                process.terminate()
            }
        } catch {
            // Ignore focus launch failures so the toast still dismisses cleanly.
        }
        DispatchQueue.main.async {
            completion()
        }
    }
}

private final class HudPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class HudRootView: NSVisualEffectView {
    private let closeButton: NSButton
    private let onBodyClick: () -> Void
    private let onHoverChanged: (Bool) -> Void
    private var hudTrackingArea: NSTrackingArea?

    init(
        frame: NSRect,
        closeButton: NSButton,
        onBodyClick: @escaping () -> Void,
        onHoverChanged: @escaping (Bool) -> Void
    ) {
        self.closeButton = closeButton
        self.onBodyClick = onBodyClick
        self.onHoverChanged = onHoverChanged
        super.init(frame: frame)
        material = .hudWindow
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 14
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        updateBorderAppearance()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateBorderAppearance()
    }

    private func updateBorderAppearance() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            self.layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.16).cgColor
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = hudTrackingArea {
            removeTrackingArea(existing)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        hudTrackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        onHoverChanged(true)
    }

    override func mouseExited(with event: NSEvent) {
        onHoverChanged(false)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        guard bounds.contains(local) else { return nil }
        let closeRect = closeButton.convert(closeButton.bounds, to: self)
        if closeRect.contains(local) {
            return closeButton
        }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        onBodyClick()
    }
}

private final class HudAppDelegate: NSObject, NSApplicationDelegate {
    private let request: NormalizedRequest
    private let slots = SlotCoordinator()
    private var panel: HudPanel?
    private var dismissTimer: Timer?
    private var remainingSeconds: TimeInterval
    private var timerStartedAt: Date?
    private var isHovered = false
    private var isDismissing = false
    private var pendingOperations = 0

    init(request: NormalizedRequest) {
        self.request = request
        self.remainingSeconds = request.card.durationSeconds
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        presentToast()
        playSound()
        scheduleDismissTimer(after: remainingSeconds)
    }

    func applicationWillTerminate(_ notification: Notification) {
        slots.release()
    }

    private func playSound() {
        switch request.sound {
        case "done":
            NSSound(named: NSSound.Name("Glass"))?.play()
        case "request":
            (NSSound(named: NSSound.Name("Purr")) ?? NSSound(named: NSSound.Name("Ping")))?.play()
        default:
            break
        }
    }

    private func makeWrappingLabel(_ text: String, font: NSFont, color: NSColor, width: CGFloat, maxLines: Int) -> (NSTextField, CGFloat) {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = font
        field.textColor = color
        field.maximumNumberOfLines = maxLines
        field.lineBreakMode = .byTruncatingTail
        field.preferredMaxLayoutWidth = width
        field.cell?.wraps = true
        field.cell?.isScrollable = false
        field.cell?.truncatesLastVisibleLine = true
        let measured = field.sizeThatFits(NSSize(width: width, height: 400))
        let maxHeight = ceil(font.ascender - font.descender + font.leading + 4) * CGFloat(maxLines)
        let height = min(ceil(measured.height), maxHeight)
        return (field, max(16, height))
    }

    private func presentToast() {
        let card = request.card
        let accentColor = colorFromHex(card.accentHex)
        let panelWidth: CGFloat = 360
        let stripeWidth: CGFloat = 4
        let leftInset: CGFloat = stripeWidth + 14
        let rightInset: CGFloat = 14
        let textWidth = panelWidth - leftInset - rightInset
        let topPad: CGFloat = 12
        let bottomPad: CGFloat = 12
        let topRowHeight: CGFloat = 20

        let badgeFont = NSFont.systemFont(ofSize: 10, weight: .bold)
        let badgeLabel = NSTextField(labelWithString: card.badge)
        badgeLabel.font = badgeFont
        badgeLabel.textColor = accentColor
        let badgeSize = badgeLabel.sizeThatFits(NSSize(width: 140, height: 18))
        let pillWidth = ceil(badgeSize.width) + 12
        let pillHeight: CGFloat = 18

        let closeButton = NSButton(frame: NSRect(x: panelWidth - 10 - 22, y: 0, width: 22, height: 22))
        closeButton.title = "×"
        closeButton.isBordered = false
        closeButton.font = NSFont.systemFont(ofSize: 15, weight: .medium)
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(closeClicked)

        let headerField = NSTextField(labelWithString: card.header)
        headerField.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        headerField.textColor = .secondaryLabelColor
        headerField.lineBreakMode = .byTruncatingTail
        headerField.cell?.truncatesLastVisibleLine = true

        let (titleField, titleHeight) = makeWrappingLabel(
            card.title,
            font: NSFont.systemFont(ofSize: 13.5, weight: .semibold),
            color: .labelColor,
            width: textWidth,
            maxLines: 2
        )

        let bodyResult: (NSTextField, CGFloat)? = card.body.isEmpty
            ? nil
            : makeWrappingLabel(
                card.body,
                font: NSFont.systemFont(ofSize: 12.5, weight: .regular),
                color: .secondaryLabelColor,
                width: textWidth,
                maxLines: 2
            )

        let hintField: NSTextField?
        let hintHeight: CGFloat = card.actionHint.isEmpty ? 0 : 15
        if card.actionHint.isEmpty {
            hintField = nil
        } else {
            let label = NSTextField(labelWithString: card.actionHint)
            label.font = NSFont.systemFont(ofSize: 11, weight: .medium)
            label.textColor = accentColor
            label.lineBreakMode = .byTruncatingTail
            hintField = label
        }

        var totalHeight = topPad + topRowHeight + 8 + titleHeight + bottomPad
        if let (_, bodyHeight) = bodyResult {
            totalHeight += 4 + bodyHeight
        }
        if hintHeight > 0 {
            totalHeight += 6 + hintHeight
        }
        totalHeight = max(84, ceil(totalHeight))

        let rootView = HudRootView(
            frame: NSRect(x: 0, y: 0, width: panelWidth, height: totalHeight),
            closeButton: closeButton,
            onBodyClick: { [weak self] in self?.handleBodyClick() },
            onHoverChanged: { [weak self] hovered in self?.handleHoverChanged(hovered) }
        )

        let stripeView = NSView(frame: NSRect(x: 0, y: 0, width: stripeWidth, height: totalHeight))
        stripeView.wantsLayer = true
        stripeView.layer?.backgroundColor = accentColor.cgColor
        rootView.addSubview(stripeView)

        let topRowY = totalHeight - topPad - topRowHeight
        let pillView = NSView(frame: NSRect(x: leftInset, y: topRowY + 1, width: pillWidth, height: pillHeight))
        pillView.wantsLayer = true
        pillView.layer?.cornerRadius = 5
        pillView.layer?.backgroundColor = accentColor.withAlphaComponent(0.18).cgColor
        badgeLabel.frame = NSRect(x: 6, y: (pillHeight - ceil(badgeSize.height)) / 2, width: ceil(badgeSize.width), height: ceil(badgeSize.height))
        pillView.addSubview(badgeLabel)
        rootView.addSubview(pillView)

        closeButton.frame = NSRect(x: panelWidth - 10 - 22, y: topRowY - 1, width: 22, height: 22)
        rootView.addSubview(closeButton)

        let headerX = leftInset + pillWidth + 8
        let headerWidth = max(40, closeButton.frame.minX - headerX - 6)
        headerField.frame = NSRect(x: headerX, y: topRowY + 2, width: headerWidth, height: 16)
        rootView.addSubview(headerField)

        var cursorY = topRowY - 8 - titleHeight
        titleField.frame = NSRect(x: leftInset, y: cursorY, width: textWidth, height: titleHeight)
        rootView.addSubview(titleField)

        if let (bodyField, bodyHeight) = bodyResult {
            cursorY = cursorY - 4 - bodyHeight
            bodyField.frame = NSRect(x: leftInset, y: cursorY, width: textWidth, height: bodyHeight)
            rootView.addSubview(bodyField)
        }

        if let hintField {
            cursorY = cursorY - 6 - hintHeight
            hintField.frame = NSRect(x: leftInset, y: cursorY, width: textWidth, height: hintHeight)
            rootView.addSubview(hintField)
        }

        let screen = NSScreen.main ?? NSScreen.screens.first
        let visibleFrame = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let yOffset = slots.acquire(height: totalHeight, durationSeconds: card.durationSeconds)
        let targetX = visibleFrame.maxX - panelWidth - 16
        let rawTargetY = visibleFrame.maxY - 16 - totalHeight - yOffset
        let targetY = max(visibleFrame.minY + 16, rawTargetY)
        let targetFrame = NSRect(x: targetX, y: targetY, width: panelWidth, height: totalHeight)
        let startFrame = targetFrame.offsetBy(dx: 24, dy: 0)

        let hudPanel = HudPanel(
            contentRect: startFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        hudPanel.level = .floating
        hudPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        hudPanel.isOpaque = false
        hudPanel.backgroundColor = .clear
        hudPanel.hasShadow = true
        hudPanel.hidesOnDeactivate = false
        hudPanel.isFloatingPanel = true
        hudPanel.becomesKeyOnlyIfNeeded = true
        hudPanel.ignoresMouseEvents = false
        hudPanel.alphaValue = 0
        hudPanel.contentView = rootView
        hudPanel.orderFrontRegardless()
        self.panel = hudPanel

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            hudPanel.animator().alphaValue = 1
            hudPanel.animator().setFrame(targetFrame, display: true)
        }
    }

    private func scheduleDismissTimer(after seconds: TimeInterval) {
        dismissTimer?.invalidate()
        guard !isDismissing, !isHovered else { return }
        let interval = max(1.0, seconds)
        remainingSeconds = interval
        timerStartedAt = Date()
        dismissTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            self?.dismiss()
        }
    }

    private func handleHoverChanged(_ hovered: Bool) {
        guard !isDismissing else { return }
        if hovered {
            isHovered = true
            if let startedAt = timerStartedAt {
                remainingSeconds = max(1.5, remainingSeconds - Date().timeIntervalSince(startedAt))
            }
            dismissTimer?.invalidate()
            dismissTimer = nil
            timerStartedAt = nil
        } else {
            isHovered = false
            scheduleDismissTimer(after: remainingSeconds)
        }
    }

    @objc private func closeClicked() {
        dismiss()
    }

    private func handleBodyClick() {
        guard !isDismissing else { return }
        if let target = request.card.target {
            pendingOperations += 1
            focusTarget(target) { [weak self] in
                guard let self = self else { return }
                self.pendingOperations = max(0, self.pendingOperations - 1)
                self.finishIfReady()
            }
        }
        dismiss()
    }

    private func dismiss() {
        guard !isDismissing else { return }
        isDismissing = true
        dismissTimer?.invalidate()
        dismissTimer = nil
        slots.release()

        guard let hudPanel = panel else {
            finishIfReady()
            return
        }
        pendingOperations += 1
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            hudPanel.animator().alphaValue = 0
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in
            guard let self = self else { return }
            self.panel?.orderOut(nil)
            self.pendingOperations = max(0, self.pendingOperations - 1)
            self.finishIfReady()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            NSApp.terminate(nil)
        }
    }

    private func finishIfReady() {
        if isDismissing && pendingOperations == 0 {
            NSApp.terminate(nil)
        }
    }
}

private func runForegroundHUD(request: NormalizedRequest) -> Never {
    let app = NSApplication.shared
    let delegate = HudAppDelegate(request: request)
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) {
        app.run()
    }
    exit(0)
}

private func main() {
    do {
        let options = try parseCliOptions(CommandLine.arguments)
        let request = try buildRequest(from: options.jsonText)
        if options.dumpCard {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(request.card)
            if let text = String(data: data, encoding: .utf8) {
                print(text)
            }
            exit(0)
        }
        if !options.foreground {
            try spawnDetachedForeground(normalizedJson: request.normalizedJson)
            exit(0)
        }
        runForegroundHUD(request: request)
    } catch {
        writeStderr("OrkestHUD: \(error.localizedDescription)")
        exit(1)
    }
}

main()
