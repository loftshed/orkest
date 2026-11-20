import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, statSync } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { buildFoundryState, resolveFoundryStatePath, resolveTaskSpecPath } from "./foundry.mjs";
import { mailboxRoot, readRoom, resolveWorktreeMarkerPath, updateRoom } from "./horde-room.mjs";
import { coordinator, memberOf, observeRoom } from "./rooms.mjs";
import { isPathAllowed } from "./smelter.mjs";
import { currentBranch, resolveRepositoryRoot } from "./worktree-provision.mjs";

const scriptsDir = fileURLToPath(new URL("../../src/py", import.meta.url));
const INTEGRATION_LOCK_TIMEOUT_MS = 30_000;
const INTEGRATION_LOCK_POLL_MS = 25;

const ADMIN_SESSION_PY = String.raw`
import base64, errno, fcntl, hashlib, json, os, re, sys, time, uuid

DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
NOFOLLOW_RDONLY = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
NOFOLLOW_EXCL_WR = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
LOCK_FLAGS = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
TX_ID_RE = re.compile(r"^[A-Za-z0-9-]+$")
TX_JOURNAL_RE = re.compile(r"^integrate-tx-([A-Za-z0-9-]+)\.json$")


def open_lock(dir_fd, name):
    # Darwin openat(O_CREAT) can report ENOENT when two workers create the same lock.
    try:
        return os.open(name, LOCK_FLAGS | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=dir_fd)
    except FileExistsError:
        return os.open(name, LOCK_FLAGS, dir_fd=dir_fd)


def validated_tx_filename(tx_name=None, integration_id=None):
    if tx_name is not None:
        if (
            not isinstance(tx_name, str)
            or "/" in tx_name
            or "\\" in tx_name
            or ".." in tx_name
            or not TX_JOURNAL_RE.match(tx_name)
        ):
            raise RuntimeError(f"Invalid integration transaction journal filename: {tx_name!r}")
        return tx_name
    if not isinstance(integration_id, str) or not TX_ID_RE.match(integration_id):
        raise RuntimeError(f"Invalid integrationId: {integration_id!r}")
    return f"integrate-tx-{integration_id}.json"

git_dir = sys.argv[1]
expected_dev = int(sys.argv[2])
expected_ino = int(sys.argv[3])

git_dir_fd = os.open(git_dir, DIR_FLAGS)
st = os.fstat(git_dir_fd)
if (st.st_dev, st.st_ino) != (expected_dev, expected_ino):
    os.close(git_dir_fd)
    sys.stderr.write("Worktree Git metadata directory identity changed\n")
    sys.exit(12)

lock_fd = open_lock(git_dir_fd, "orkest.integrate.lock")
try:
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    os.close(lock_fd)
    os.close(git_dir_fd)
    sys.exit(11)

sys.stdout.write(json.dumps({"ok": True, "status": "locked"}) + "\n")
sys.stdout.flush()

ownership = {
    "orkest_dir": None,
    "task_spec": None,
    "foundry_state": None,
    "marker": None,
    "private_index_dirs": [],
    "task_lock_fd": None,
}

def owner_tuple(stat_res):
    return (stat_res.st_dev, stat_res.st_ino)

def fsync_dir(fd):
    try:
        os.fsync(fd)
    except OSError:
        pass

def read_all_fd(fd):
    chunks = []
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)

def write_all_fd(fd, raw_bytes):
    view = memoryview(raw_bytes)
    offset = 0
    while offset < len(view):
        offset += os.write(fd, view[offset:])

def validate_rel_subpath(rel, *, allow_empty=False):
    if not isinstance(rel, str) or "\0" in rel or "\\" in rel:
        raise RuntimeError(f"Invalid relative path: {rel!r}")
    if rel.startswith("/") or (len(rel) >= 2 and rel[1] == ":"):
        raise RuntimeError(f"Absolute path is not allowed: {rel!r}")
    parts = [p for p in rel.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise RuntimeError(f"Parent traversal '..' is not allowed: {rel!r}")
    if not allow_empty and not parts:
        raise RuntimeError(f"Empty relative path is not allowed: {rel!r}")
    return parts

def lock_payload_bytes(integration_id, lock_token):
    return f"orkest-index-lock-v1:{integration_id}:{lock_token}\n".encode("utf-8")

def open_sub_dir_fd(parent_fd, rel):
    import stat as stat_mod
    cur = parent_fd
    opened = []
    try:
        parts = validate_rel_subpath(rel, allow_empty=True)
        for part in parts:
            info = os.lstat(part, dir_fd=cur)
            if stat_mod.S_ISLNK(info.st_mode) or not stat_mod.S_ISDIR(info.st_mode):
                raise RuntimeError(f"Directory component is invalid or a symlink: {part}")
            nxt = os.open(part, DIR_FLAGS, dir_fd=cur)
            opened.append(nxt)
            cur = nxt
        return cur, opened
    except Exception:
        for fd in reversed(opened):
            os.close(fd)
        raise

def ensure_orkest_dir_fd():
    import stat as stat_mod
    created_dir = False
    try:
        dir_info = os.lstat("orkest", dir_fd=git_dir_fd)
        if stat_mod.S_ISLNK(dir_info.st_mode) or not stat_mod.S_ISDIR(dir_info.st_mode):
            raise RuntimeError("Member worktree orkest metadata directory is invalid or a symlink")
    except FileNotFoundError:
        os.mkdir("orkest", 0o700, dir_fd=git_dir_fd)
        fsync_dir(git_dir_fd)
        created_dir = True
    orkest_fd = os.open("orkest", DIR_FLAGS, dir_fd=git_dir_fd)
    if created_dir and ownership["orkest_dir"] is None:
        ownership["orkest_dir"] = owner_tuple(os.fstat(orkest_fd))
    return orkest_fd

def write_atomic_in_dir(dir_fd, name, raw_bytes, *, replace_existing=False):
    if not replace_existing:
        try:
            os.lstat(name, dir_fd=dir_fd)
            raise RuntimeError("Member worktree already has Orkest merge-queue metadata")
        except FileNotFoundError:
            pass
    tmp_name = f".{name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    tmp_fd = os.open(tmp_name, NOFOLLOW_EXCL_WR, 0o600, dir_fd=dir_fd)
    try:
        write_all_fd(tmp_fd, raw_bytes)
        os.fsync(tmp_fd)
        file_owner = owner_tuple(os.fstat(tmp_fd))
    finally:
        os.close(tmp_fd)
    try:
        if replace_existing:
            try:
                info = os.lstat(name, dir_fd=dir_fd)
                import stat as stat_mod
                if stat_mod.S_ISLNK(info.st_mode) or not stat_mod.S_ISREG(info.st_mode):
                    raise RuntimeError("Member worktree metadata file is invalid or a symlink")
            except FileNotFoundError:
                pass
            os.replace(tmp_name, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        else:
            os.link(tmp_name, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
            os.unlink(tmp_name, dir_fd=dir_fd)
        fsync_dir(dir_fd)
        return file_owner
    except BaseException as exc:
        try:
            os.unlink(tmp_name, dir_fd=dir_fd)
        except OSError:
            pass
        if isinstance(exc, FileExistsError):
            raise RuntimeError("Member worktree already has Orkest merge-queue metadata") from exc
        raise

def unlink_owned(dir_fd, name, expected_owner):
    if not expected_owner:
        return
    try:
        info = os.lstat(name, dir_fd=dir_fd)
    except FileNotFoundError:
        return
    import stat as stat_mod
    if stat_mod.S_ISLNK(info.st_mode) or not stat_mod.S_ISREG(info.st_mode):
        return
    if owner_tuple(info) != expected_owner:
        return
    os.unlink(name, dir_fd=dir_fd)
    fsync_dir(dir_fd)

def cleanup_private_index_dir(dir_name):
    try:
        sub_dir_fd = os.open(dir_name, DIR_FLAGS, dir_fd=git_dir_fd)
    except FileNotFoundError:
        return
    try:
        for fname in ("index", "COMMIT_EDITMSG"):
            try:
                os.unlink(fname, dir_fd=sub_dir_fd)
            except FileNotFoundError:
                pass
    finally:
        os.close(sub_dir_fd)
    try:
        os.rmdir(dir_name, dir_fd=git_dir_fd)
    except OSError:
        pass

def handle_op(req):
    op = req["op"]
    if op == "acquire_task_lock":
        if ownership["task_lock_fd"] is not None:
            return {"ok": True}
        task_dir = req["task_dir"]
        task_dir_fd = os.open(task_dir, DIR_FLAGS)
        try:
            task_lock_fd = open_lock(task_dir_fd, "task.json.lock")
        finally:
            os.close(task_dir_fd)
        deadline = time.monotonic() + 30.0
        while True:
            try:
                fcntl.flock(task_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    os.close(task_lock_fd)
                    raise RuntimeError("Timed out waiting for coordinator task.json.lock")
                time.sleep(0.01)
        ownership["task_lock_fd"] = task_lock_fd
        return {"ok": True}

    if op == "release_task_lock":
        task_lock_fd = ownership["task_lock_fd"]
        ownership["task_lock_fd"] = None
        if task_lock_fd is not None:
            try:
                os.close(task_lock_fd)
            except OSError:
                pass
        return {"ok": True}

    if op == "write_private_index":
        dir_name = f"orkest.index_tmp.{os.getpid()}.{uuid.uuid4().hex}"
        os.mkdir(dir_name, 0o700, dir_fd=git_dir_fd)
        ownership["private_index_dirs"].append(dir_name)
        raw = base64.b64decode(req["bytes_b64"]) if req.get("bytes_b64") is not None else None
        if raw:
            sub_dir_fd = os.open(dir_name, DIR_FLAGS, dir_fd=git_dir_fd)
            try:
                fd = os.open("index", NOFOLLOW_EXCL_WR, 0o600, dir_fd=sub_dir_fd)
                try:
                    write_all_fd(fd, raw)
                    os.fsync(fd)
                finally:
                    os.close(fd)
            finally:
                os.close(sub_dir_fd)
        return {
            "ok": True,
            "dir_name": dir_name,
            "name": f"{dir_name}/index",
            "path": os.path.join(git_dir, dir_name, "index"),
        }

    if op == "cleanup_private_index":
        dir_name = req.get("dir_name") or os.path.dirname(req["name"])
        if dir_name in ownership["private_index_dirs"]:
            cleanup_private_index_dir(dir_name)
            ownership["private_index_dirs"].remove(dir_name)
        return {"ok": True}

    if op == "list_tx_journals":
        import stat as stat_mod
        try:
            dir_info = os.lstat("orkest", dir_fd=git_dir_fd)
        except FileNotFoundError:
            return {"ok": True, "journals": []}
        if stat_mod.S_ISLNK(dir_info.st_mode) or not stat_mod.S_ISDIR(dir_info.st_mode):
            raise RuntimeError("Member worktree orkest metadata directory is invalid or a symlink")
        orkest_fd = os.open("orkest", DIR_FLAGS, dir_fd=git_dir_fd)
        journals = []
        try:
            for entry in sorted(os.listdir(orkest_fd)):
                if not TX_JOURNAL_RE.match(entry):
                    continue
                fd = os.open(entry, NOFOLLOW_RDONLY, dir_fd=orkest_fd)
                try:
                    raw = read_all_fd(fd).decode("utf-8")
                finally:
                    os.close(fd)
                journals.append({"name": entry, "tx": json.loads(raw)})
        finally:
            os.close(orkest_fd)
        return {"ok": True, "journals": journals}

    if op == "write_tx_journal":
        tx = req["tx"]
        tx_name = validated_tx_filename(integration_id=tx.get("integrationId"))
        tx_bytes = (json.dumps(tx, indent=2) + "\n").encode("utf-8")
        orkest_fd = ensure_orkest_dir_fd()
        try:
            write_atomic_in_dir(orkest_fd, tx_name, tx_bytes, replace_existing=True)
        finally:
            os.close(orkest_fd)
        return {"ok": True, "name": tx_name}

    if op == "delete_tx_journal":
        tx_name = validated_tx_filename(
            tx_name=req.get("name"), integration_id=req.get("integrationId")
        )
        try:
            orkest_fd = os.open("orkest", DIR_FLAGS, dir_fd=git_dir_fd)
        except FileNotFoundError:
            return {"ok": True}
        try:
            try:
                os.unlink(tx_name, dir_fd=orkest_fd)
                fsync_dir(orkest_fd)
            except FileNotFoundError:
                pass
        finally:
            os.close(orkest_fd)
        if ownership["orkest_dir"]:
            try:
                dir_info = os.lstat("orkest", dir_fd=git_dir_fd)
                import stat as stat_mod
                if not stat_mod.S_ISLNK(dir_info.st_mode) and stat_mod.S_ISDIR(dir_info.st_mode) and owner_tuple(dir_info) == ownership["orkest_dir"]:
                    os.rmdir("orkest", dir_fd=git_dir_fd)
                    fsync_dir(git_dir_fd)
                    ownership["orkest_dir"] = None
            except OSError:
                pass
        return {"ok": True}

    if op == "rollback_uncommitted_tx":
        tx_name = validated_tx_filename(tx_name=req.get("name"))
        try:
            orkest_fd = os.open("orkest", DIR_FLAGS, dir_fd=git_dir_fd)
        except FileNotFoundError:
            return {"ok": True}
        try:
            for fname in ("foundry-state.json", "task-spec.json", tx_name):
                try:
                    info = os.lstat(fname, dir_fd=orkest_fd)
                    import stat as stat_mod
                    if not stat_mod.S_ISLNK(info.st_mode) and stat_mod.S_ISREG(info.st_mode):
                        os.unlink(fname, dir_fd=orkest_fd)
                except FileNotFoundError:
                    pass
            fsync_dir(orkest_fd)
        finally:
            os.close(orkest_fd)
        try:
            os.rmdir("orkest", dir_fd=git_dir_fd)
            fsync_dir(git_dir_fd)
        except OSError:
            pass
        return {"ok": True}

    if op == "write_metadata":
        replace_existing = bool(req.get("replace_existing"))
        if not replace_existing:
            try:
                os.lstat("orkest.json", dir_fd=git_dir_fd)
                raise RuntimeError("Member worktree already has Orkest merge-queue metadata")
            except FileNotFoundError:
                pass
        orkest_fd = ensure_orkest_dir_fd()
        try:
            spec_bytes = (json.dumps(req["task_spec"], indent=2) + "\n").encode("utf-8")
            state_bytes = (json.dumps(req["foundry_state"], indent=2) + "\n").encode("utf-8")
            ownership["task_spec"] = write_atomic_in_dir(
                orkest_fd, "task-spec.json", spec_bytes, replace_existing=replace_existing
            )
            ownership["foundry_state"] = write_atomic_in_dir(
                orkest_fd, "foundry-state.json", state_bytes, replace_existing=replace_existing
            )
        finally:
            os.close(orkest_fd)
        return {"ok": True}

    if op == "write_marker":
        replace_existing = bool(req.get("replace_existing"))
        marker_bytes = (json.dumps(req["marker"], indent=2) + "\n").encode("utf-8")
        ownership["marker"] = write_atomic_in_dir(
            git_dir_fd, "orkest.json", marker_bytes, replace_existing=replace_existing
        )
        return {"ok": True}

    if op == "read_marker":
        try:
            fd = os.open("orkest.json", NOFOLLOW_RDONLY, dir_fd=git_dir_fd)
        except FileNotFoundError:
            return {"ok": True, "marker": None}
        try:
            raw = read_all_fd(fd).decode("utf-8")
            return {"ok": True, "marker": json.loads(raw)}
        finally:
            os.close(fd)

    if op == "rollback_metadata":
        unlink_owned(git_dir_fd, "orkest.json", ownership["marker"])
        ownership["marker"] = None
        try:
            orkest_fd = os.open("orkest", DIR_FLAGS, dir_fd=git_dir_fd)
        except FileNotFoundError:
            orkest_fd = None
        if orkest_fd is not None:
            try:
                unlink_owned(orkest_fd, "foundry-state.json", ownership["foundry_state"])
                ownership["foundry_state"] = None
                unlink_owned(orkest_fd, "task-spec.json", ownership["task_spec"])
                ownership["task_spec"] = None
            finally:
                os.close(orkest_fd)
        if ownership["orkest_dir"]:
            try:
                dir_info = os.lstat("orkest", dir_fd=git_dir_fd)
                import stat as stat_mod
                if not stat_mod.S_ISLNK(dir_info.st_mode) and stat_mod.S_ISDIR(dir_info.st_mode) and owner_tuple(dir_info) == ownership["orkest_dir"]:
                    os.rmdir("orkest", dir_fd=git_dir_fd)
                    fsync_dir(git_dir_fd)
                    ownership["orkest_dir"] = None
            except OSError:
                pass
        return {"ok": True}

    if op == "swap_index":
        import stat as stat_mod
        index_rel = req["index_rel"]
        private_name = req["private_index_name"]
        private_dir = req.get("private_dir_name") or os.path.dirname(private_name)
        private_file = os.path.basename(private_name)
        expected_live_sha256 = req.get("expected_live_sha256")
        integration_id = req.get("integration_id")
        lock_token = req.get("lock_token")
        reclaim_lock_token = req.get("reclaim_lock_token")
        index_parts = validate_rel_subpath(index_rel, allow_empty=False)
        parent_rel = "/".join(index_parts[:-1])
        index_name = index_parts[-1]
        lock_name = f"{index_name}.lock"
        private_dir_parts = validate_rel_subpath(private_dir, allow_empty=True)
        if len(private_dir_parts) > 1 or any(p in (".", "..") for p in private_dir_parts):
            raise RuntimeError("Invalid private index directory")
        private_file_parts = validate_rel_subpath(private_file, allow_empty=False)
        if len(private_file_parts) != 1:
            raise RuntimeError("Invalid private index filename")
        idx_dir_fd, opened = open_sub_dir_fd(git_dir_fd, parent_rel)
        sub_dir_fd = os.open(private_dir_parts[0], DIR_FLAGS, dir_fd=git_dir_fd) if private_dir_parts else git_dir_fd
        lock_acquired = False
        lock_bytes = (
            lock_payload_bytes(integration_id, lock_token)
            if isinstance(integration_id, str) and integration_id and isinstance(lock_token, str) and lock_token
            else b""
        )
        lock_tmp_name = f".{lock_name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        try:
            lock_tmp_fd = os.open(lock_tmp_name, NOFOLLOW_EXCL_WR, 0o600, dir_fd=idx_dir_fd)
            try:
                if lock_bytes:
                    write_all_fd(lock_tmp_fd, lock_bytes)
                os.fsync(lock_tmp_fd)
            finally:
                os.close(lock_tmp_fd)
            try:
                try:
                    os.link(lock_tmp_name, lock_name, src_dir_fd=idx_dir_fd, dst_dir_fd=idx_dir_fd)
                    lock_acquired = True
                except FileExistsError as exc:
                    if not (isinstance(integration_id, str) and integration_id and isinstance(reclaim_lock_token, str) and reclaim_lock_token):
                        raise RuntimeError("Member worktree Git index lock is held by another process") from exc
                    expected_reclaim = lock_payload_bytes(integration_id, reclaim_lock_token)
                    try:
                        lock_info = os.lstat(lock_name, dir_fd=idx_dir_fd)
                    except FileNotFoundError:
                        lock_info = None
                    if lock_info is not None:
                        if stat_mod.S_ISLNK(lock_info.st_mode) or not stat_mod.S_ISREG(lock_info.st_mode):
                            raise RuntimeError("Member worktree Git index lock is held by another process") from exc
                        existing_fd = os.open(lock_name, NOFOLLOW_RDONLY, dir_fd=idx_dir_fd)
                        try:
                            existing_bytes = read_all_fd(existing_fd)
                        finally:
                            os.close(existing_fd)
                        if existing_bytes != expected_reclaim:
                            raise RuntimeError("Member worktree Git index lock is held by another process") from exc
                        os.unlink(lock_name, dir_fd=idx_dir_fd)
                        fsync_dir(idx_dir_fd)
                    try:
                        os.link(lock_tmp_name, lock_name, src_dir_fd=idx_dir_fd, dst_dir_fd=idx_dir_fd)
                        lock_acquired = True
                    except FileExistsError as exc2:
                        raise RuntimeError("Member worktree Git index lock is held by another process") from exc2
            finally:
                try:
                    os.unlink(lock_tmp_name, dir_fd=idx_dir_fd)
                except FileNotFoundError:
                    pass
            try:
                try:
                    live_fd = os.open(index_name, NOFOLLOW_RDONLY, dir_fd=idx_dir_fd)
                except FileNotFoundError:
                    if expected_live_sha256 is not None:
                        raise RuntimeError("Member worktree index was removed concurrently during integration")
                else:
                    try:
                        live_bytes = read_all_fd(live_fd)
                    finally:
                        os.close(live_fd)
                    if expected_live_sha256 is None or hashlib.sha256(live_bytes).hexdigest() != expected_live_sha256:
                        raise RuntimeError("Member worktree index changed concurrently during integration")
                priv_fd = os.open(private_file, NOFOLLOW_RDONLY, dir_fd=sub_dir_fd)
                try:
                    new_sha256 = hashlib.sha256(read_all_fd(priv_fd)).hexdigest()
                finally:
                    os.close(priv_fd)
                os.replace(private_file, index_name, src_dir_fd=sub_dir_fd, dst_dir_fd=idx_dir_fd)
                fsync_dir(idx_dir_fd)
                if private_dir in ownership["private_index_dirs"]:
                    cleanup_private_index_dir(private_dir)
                    ownership["private_index_dirs"].remove(private_dir)
                return {"ok": True, "installedSha256": new_sha256}
            finally:
                if lock_acquired:
                    try:
                        os.unlink(lock_name, dir_fd=idx_dir_fd)
                    except FileNotFoundError:
                        pass
        finally:
            if sub_dir_fd != git_dir_fd:
                os.close(sub_dir_fd)
            for fd in reversed(opened):
                os.close(fd)

    if op == "reclaim_abandoned_index_lock":
        import stat as stat_mod
        index_rel = req["index_rel"]
        integration_id = req.get("integration_id")
        reclaim_lock_token = req.get("reclaim_lock_token")
        index_parts = validate_rel_subpath(index_rel, allow_empty=False)
        parent_rel = "/".join(index_parts[:-1])
        index_name = index_parts[-1]
        lock_name = f"{index_name}.lock"
        idx_dir_fd, opened = open_sub_dir_fd(git_dir_fd, parent_rel)
        try:
            try:
                lock_info = os.lstat(lock_name, dir_fd=idx_dir_fd)
            except FileNotFoundError:
                return {"ok": True, "reclaimed": False}
            if stat_mod.S_ISLNK(lock_info.st_mode) or not stat_mod.S_ISREG(lock_info.st_mode):
                raise RuntimeError("Member worktree Git index lock is held by another process")
            if not (isinstance(integration_id, str) and integration_id and isinstance(reclaim_lock_token, str) and reclaim_lock_token):
                raise RuntimeError("Member worktree Git index lock is held by another process")
            existing_fd = os.open(lock_name, NOFOLLOW_RDONLY, dir_fd=idx_dir_fd)
            try:
                existing_bytes = read_all_fd(existing_fd)
            finally:
                os.close(existing_fd)
            if existing_bytes != lock_payload_bytes(integration_id, reclaim_lock_token):
                raise RuntimeError("Member worktree Git index lock is held by another process")
            os.unlink(lock_name, dir_fd=idx_dir_fd)
            fsync_dir(idx_dir_fd)
            return {"ok": True, "reclaimed": True}
        finally:
            for fd in reversed(opened):
                os.close(fd)

    if op == "restore_index":
        index_rel = req["index_rel"]
        expected_current = req["expected_current_sha256"]
        original_bytes = base64.b64decode(req["original_b64"]) if req.get("original_b64") is not None else None
        index_parts = validate_rel_subpath(index_rel, allow_empty=False)
        parent_rel = "/".join(index_parts[:-1])
        index_name = index_parts[-1]
        lock_name = f"{index_name}.lock"
        idx_dir_fd, opened = open_sub_dir_fd(git_dir_fd, parent_rel)
        try:
            idx_lock_fd = os.open(lock_name, NOFOLLOW_EXCL_WR, 0o600, dir_fd=idx_dir_fd)
            try:
                live_fd = os.open(index_name, NOFOLLOW_RDONLY, dir_fd=idx_dir_fd)
                try:
                    cur_sha = hashlib.sha256(read_all_fd(live_fd)).hexdigest()
                finally:
                    os.close(live_fd)
                if cur_sha != expected_current:
                    return {"ok": True, "skipped": True}
                if original_bytes is None:
                    os.unlink(index_name, dir_fd=idx_dir_fd)
                else:
                    tmp_name = f".{index_name}.restore.{os.getpid()}.{uuid.uuid4().hex}.tmp"
                    tmp_fd = os.open(tmp_name, NOFOLLOW_EXCL_WR, 0o600, dir_fd=idx_dir_fd)
                    try:
                        write_all_fd(tmp_fd, original_bytes)
                        os.fsync(tmp_fd)
                    finally:
                        os.close(tmp_fd)
                    os.replace(tmp_name, index_name, src_dir_fd=idx_dir_fd, dst_dir_fd=idx_dir_fd)
                fsync_dir(idx_dir_fd)
                return {"ok": True}
            finally:
                os.close(idx_lock_fd)
                try:
                    os.unlink(lock_name, dir_fd=idx_dir_fd)
                except FileNotFoundError:
                    pass
        finally:
            for fd in reversed(opened):
                os.close(fd)

    if op == "stat_live_index":
        index_rel = req["index_rel"]
        index_parts = validate_rel_subpath(index_rel, allow_empty=False)
        parent_rel = "/".join(index_parts[:-1])
        index_name = index_parts[-1]
        idx_dir_fd, opened = open_sub_dir_fd(git_dir_fd, parent_rel)
        try:
            try:
                live_fd = os.open(index_name, NOFOLLOW_RDONLY, dir_fd=idx_dir_fd)
            except FileNotFoundError:
                return {"ok": True, "exists": False, "sha256": None}
            try:
                return {"ok": True, "exists": True, "sha256": hashlib.sha256(read_all_fd(live_fd)).hexdigest()}
            finally:
                os.close(live_fd)
        finally:
            for fd in reversed(opened):
                os.close(fd)

    if op == "read_rollback_txs":
        try:
            fd = os.open("orkest.integrate.rollbacks", NOFOLLOW_RDONLY, dir_fd=git_dir_fd)
        except FileNotFoundError:
            return {"ok": True, "txIds": []}
        try:
            raw = os.read(fd, 65536).decode("utf-8")
            parsed = json.loads(raw) if raw.strip() else []
            return {"ok": True, "txIds": parsed if isinstance(parsed, list) else []}
        except Exception:
            return {"ok": True, "txIds": []}
        finally:
            os.close(fd)

    if op == "record_rollback_tx":
        tx_id = req["txId"]
        existing = []
        try:
            fd = os.open("orkest.integrate.rollbacks", NOFOLLOW_RDONLY, dir_fd=git_dir_fd)
            try:
                raw = os.read(fd, 65536).decode("utf-8")
                parsed = json.loads(raw) if raw.strip() else []
                if isinstance(parsed, list):
                    existing = [x for x in parsed if isinstance(x, str)]
            finally:
                os.close(fd)
        except Exception:
            existing = []
        if tx_id not in existing:
            existing.append(tx_id)
        tmp_name = f".orkest.rollbacks.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        tmp_fd = os.open(tmp_name, NOFOLLOW_EXCL_WR, 0o600, dir_fd=git_dir_fd)
        try:
            os.write(tmp_fd, (json.dumps(existing) + "\n").encode("utf-8"))
            os.fsync(tmp_fd)
        finally:
            os.close(tmp_fd)
        os.replace(tmp_name, "orkest.integrate.rollbacks", src_dir_fd=git_dir_fd, dst_dir_fd=git_dir_fd)
        fsync_dir(git_dir_fd)
        return {"ok": True}

    if op == "clear_rollback_tx":
        try:
            os.unlink("orkest.integrate.rollbacks", dir_fd=git_dir_fd)
            fsync_dir(git_dir_fd)
        except FileNotFoundError:
            pass
        return {"ok": True}

    raise RuntimeError(f"Unknown admin session op: {op}")

try:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        if req.get("op") == "release":
            sys.stdout.write(json.dumps({"ok": True}) + "\n")
            sys.stdout.flush()
            break
        try:
            res = handle_op(req)
        except Exception as exc:
            res = {"ok": False, "error": str(exc)}
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()
finally:
    task_lock_fd = ownership.get("task_lock_fd")
    if task_lock_fd is not None:
        try:
            os.close(task_lock_fd)
        except OSError:
            pass
    for p_dir in list(ownership["private_index_dirs"]):
        cleanup_private_index_dir(p_dir)
    try:
        os.close(lock_fd)
    except OSError:
        pass
    try:
        os.close(git_dir_fd)
    except OSError:
        pass
`;

function invokeGit(exec, cwd, args, extraEnv, input) {
  const execOptions = {
    cwd,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(extraEnv && { env: { ...process.env, ...extraEnv } }),
    ...(input !== undefined && { input }),
  };
  if (exec) return exec("git", args, execOptions);
  try {
    return {
      status: 0,
      stdout: execFileSync("git", args, execOptions),
      stderr: "",
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() || error.message,
    };
  }
}

function gitOutput(exec, cwd, args, extraEnv, input) {
  const result = invokeGit(exec, cwd, args, extraEnv, input);
  if (typeof result === "string") return result;
  if (!result || result.status !== 0) {
    const detail = result?.stderr?.trim() || result?.stdout?.trim() || "git command failed";
    throw new Error(`Git command failed in ${cwd}: git ${args.join(" ")}: ${detail}`);
  }
  return String(result.stdout ?? "");
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const TX_JOURNAL_ENTRY_RE = /^integrate-tx-([A-Za-z0-9-]+)\.json$/u;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

function canonicalJsonBytes(value) {
  const sortValue = (item) => {
    if (Array.isArray(item)) return item.map(sortValue);
    if (item && typeof item === "object") {
      const sorted = {};
      const keys = Object.keys(item).sort((a, b) => a.localeCompare(b));
      for (const key of keys) {
        if (item[key] !== undefined) sorted[key] = sortValue(item[key]);
      }
      return sorted;
    }
    return item;
  };
  return Buffer.from(JSON.stringify(sortValue(value)), "utf8");
}

function taskSpecDigest(taskSpec) {
  return sha256Hex(canonicalJsonBytes(taskSpec));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readResultRecord(filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size > 4 * 1024 * 1024) return null;
  try {
    const bytes = await readFile(filePath);
    const result = JSON.parse(bytes.toString("utf8"));
    if (!isPlainObject(result)) return null;
    return { result, sha256: sha256Hex(bytes) };
  } catch {
    return null;
  }
}

function parseNulPaths(output) {
  return String(output ?? "")
    .split("\0")
    .filter(Boolean);
}

function isValidCommitSubject(message) {
  return (
    typeof message === "string" &&
    message === message.trim() &&
    /^[a-z][a-z0-9-]*(?:\([^\r\n()]+\))?!?: \S.*$/u.test(message)
  );
}

function hasInvalidRelativeSyntax(rawPath) {
  if (typeof rawPath !== "string" || !rawPath) return true;
  const check = rawPath.trim();
  if (
    !check ||
    rawPath.includes("\0") ||
    check.startsWith("/") ||
    check.startsWith("\\") ||
    /^[A-Za-z]:/u.test(check)
  ) {
    return true;
  }
  return check.replaceAll("\\", "/").split("/").includes("..");
}

function isValidAllowedPath(entry) {
  return !hasInvalidRelativeSyntax(entry);
}

function isChangedPathAllowed(changedPath, allowedPaths) {
  if (hasInvalidRelativeSyntax(changedPath)) return false;
  return isPathAllowed(changedPath, allowedPaths);
}

function isCanonicalWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function verifyNonSymlinkDirectory(dirPath, expectedCanonical, label) {
  const dirStat = await lstat(dirPath);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`${label} is invalid or a symlink`);
  }
  const canonical = await realpath(dirPath);
  if (canonical !== expectedCanonical) {
    throw new Error(`${label} escapes verified directory`);
  }
}

async function verifyWorktreeAdminDir(worktreePath, worktreeCommonDir, exec) {
  const dotGitPath = path.join(worktreePath, ".git");
  const dotGitStat = await lstat(dotGitPath);
  if (dotGitStat.isSymbolicLink() || !dotGitStat.isFile()) {
    throw new Error("Member worktree .git link is missing, invalid, or a symlink");
  }
  const dotGitCanonical = await realpath(dotGitPath);
  const dotGitText = await readFile(dotGitPath, "utf8");
  const dotGitMatch = /^gitdir:\s*(.+)$/mu.exec(dotGitText);
  if (!dotGitMatch) {
    throw new Error("Member worktree .git file does not point to a Git directory");
  }
  const linkedGitDirRaw = path.resolve(worktreePath, dotGitMatch[1].trim());
  const revParseGitDirRaw = path.resolve(
    worktreePath,
    gitOutput(exec, worktreePath, ["rev-parse", "--git-dir"]).trim(),
  );
  const [linkedGitDir, worktreeGitDir] = await Promise.all([
    realpath(linkedGitDirRaw),
    realpath(revParseGitDirRaw),
  ]);
  if (linkedGitDir !== worktreeGitDir) {
    throw new Error("Member worktree .git link disagrees with registered Git metadata directory");
  }
  if (worktreeGitDir === worktreeCommonDir) {
    throw new Error("Member worktree Git directory resolves to the shared repository directory");
  }
  await verifyNonSymlinkDirectory(
    revParseGitDirRaw,
    worktreeGitDir,
    "Member worktree Git metadata directory",
  );

  const gitDirHandle = await open(
    worktreeGitDir,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const gitDirStat = await gitDirHandle.stat({ bigint: true });

    const backlinkPath = path.join(worktreeGitDir, "gitdir");
    let backlinkStat;
    try {
      backlinkStat = await lstat(backlinkPath);
    } catch (error) {
      throw new Error(`Member worktree Git backlink is missing: ${error.message}`, {
        cause: error,
      });
    }
    if (backlinkStat.isSymbolicLink() || !backlinkStat.isFile()) {
      throw new Error("Member worktree Git backlink is invalid or a symlink");
    }
    const backlinkTarget = (await readFile(backlinkPath, "utf8")).trim();
    if (!backlinkTarget) {
      throw new Error("Member worktree Git backlink is empty");
    }
    const resolvedBacklink = await realpath(path.resolve(worktreeGitDir, backlinkTarget));
    if (resolvedBacklink !== dotGitCanonical) {
      throw new Error("Member worktree Git backlink does not point back to the member worktree");
    }

    const markerPath = resolveWorktreeMarkerPath(worktreePath);
    if (!markerPath) throw new Error("Cannot locate the member worktree Git metadata directory");
    const markerParentCanonical = await realpath(path.dirname(markerPath));
    if (markerParentCanonical !== worktreeGitDir || path.basename(markerPath) !== "orkest.json") {
      throw new Error("Member worktree metadata marker escapes registered Git metadata directory");
    }
    return { worktreeGitDir, markerPath, gitDirHandle, gitDirStat };
  } catch (error) {
    await gitDirHandle.close();
    throw error;
  }
}

async function verifyOrkestDirSafety(orkestDir, worktreeGitDir) {
  await verifyNonSymlinkDirectory(
    worktreeGitDir,
    worktreeGitDir,
    "Member worktree Git metadata directory",
  );
  const orkestStat = await lstat(orkestDir);
  if (orkestStat.isSymbolicLink() || !orkestStat.isDirectory()) {
    throw new Error("Member worktree orkest metadata directory is invalid or a symlink");
  }
  const orkestCanonical = await realpath(orkestDir);
  if (orkestCanonical !== path.join(worktreeGitDir, "orkest")) {
    throw new Error("Member worktree orkest metadata directory escapes Git metadata directory");
  }
}

function spawnAdminSessionOnce(worktreeGitDir, gitDirStat) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      [
        "-B",
        "-c",
        ADMIN_SESSION_PY,
        worktreeGitDir,
        String(gitDirStat.dev),
        String(gitDirStat.ino),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let buffer = "";
    let stderr = "";
    let isLocked = false;
    let pending = null;
    let isSettled = false;

    const settle = (fn, value) => {
      if (isSettled) return;
      isSettled = true;
      fn(value);
    };

    const failPending = (error) => {
      settle(reject, error);
      if (!pending) return;
      const { reject: rej } = pending;
      pending = null;
      rej(error);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (error) {
          failPending(new Error(`Invalid admin session response: ${error.message}`));
          return;
        }
        if (isLocked) {
          if (pending) {
            const { resolve: res, reject: rej } = pending;
            pending = null;
            if (msg.ok) res(msg);
            else rej(new Error(msg.error || "Admin session operation failed"));
          }
        } else {
          isLocked = true;
          settle(resolve, session);
        }
      }
    });
    child.on("error", failPending);
    child.on("close", (code) => {
      if (!isSettled) {
        if (code === 11) {
          settle(resolve, { busy: true });
        } else {
          settle(
            reject,
            new Error(stderr.trim() || `Worktree integration lock failed (exit ${code})`),
          );
        }
        return;
      }
      if (!pending) return;
      const { reject: rej } = pending;
      pending = null;
      rej(new Error(stderr.trim() || `Admin session exited unexpectedly (${code})`));
    });

    const call = (payload) =>
      new Promise((res, rej) => {
        if (pending) {
          rej(new Error("Concurrent admin session call"));
          return;
        }
        pending = { resolve: res, reject: rej };
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      });

    const session = {
      busy: false,
      acquireTaskLock: (taskDir) => call({ op: "acquire_task_lock", task_dir: taskDir }),
      releaseTaskLock: () => call({ op: "release_task_lock" }),
      writePrivateIndex: (bytes) =>
        call({
          op: "write_private_index",
          bytes_b64: bytes ? bytes.toString("base64") : null,
        }),
      cleanupPrivateIndex: (name, dirName) =>
        call({ op: "cleanup_private_index", name, dir_name: dirName }),
      listTxJournals: () => call({ op: "list_tx_journals" }),
      writeTxJournal: (tx) => call({ op: "write_tx_journal", tx }),
      deleteTxJournal: (target) =>
        call(
          typeof target === "object" && target !== null
            ? { op: "delete_tx_journal", ...target }
            : { op: "delete_tx_journal", integrationId: target },
        ),
      rollbackUncommittedTx: (name) => call({ op: "rollback_uncommitted_tx", name }),
      writeMetadata: (taskSpec, foundryState, isReplacingExisting = false) =>
        call({
          op: "write_metadata",
          task_spec: taskSpec,
          foundry_state: foundryState,
          replace_existing: isReplacingExisting,
        }),
      writeMarker: (marker, isReplacingExisting = false) =>
        call({ op: "write_marker", marker, replace_existing: isReplacingExisting }),
      readMarker: () => call({ op: "read_marker" }),
      rollbackMetadata: () => call({ op: "rollback_metadata" }),
      swapIndex: (
        privateIndexName,
        indexRel,
        expectedLiveSha256,
        privateDirName,
        { integrationId = null, lockToken = null, reclaimLockToken = null } = {},
      ) =>
        call({
          op: "swap_index",
          private_index_name: privateIndexName,
          private_dir_name: privateDirName,
          index_rel: indexRel,
          expected_live_sha256: expectedLiveSha256,
          integration_id: integrationId,
          lock_token: lockToken,
          reclaim_lock_token: reclaimLockToken,
        }),
      reclaimAbandonedIndexLock: (indexRel, integrationId, reclaimLockToken) =>
        call({
          op: "reclaim_abandoned_index_lock",
          index_rel: indexRel,
          integration_id: integrationId,
          reclaim_lock_token: reclaimLockToken,
        }),
      restoreIndex: (originalBytes, expectedCurrentSha256, indexRel) =>
        call({
          op: "restore_index",
          original_b64: originalBytes ? originalBytes.toString("base64") : null,
          expected_current_sha256: expectedCurrentSha256,
          index_rel: indexRel,
        }),
      statLiveIndex: (indexRel) => call({ op: "stat_live_index", index_rel: indexRel }),
      readRollbackTxs: () => call({ op: "read_rollback_txs" }),
      recordRollbackTx: (txId) => call({ op: "record_rollback_tx", txId }),
      clearRollbackTx: () => call({ op: "clear_rollback_tx" }),
      async release() {
        const safeRelease = async () => {
          try {
            await call({ op: "release" });
          } catch {
            // Ignore release errors on shutdown.
          }
        };
        try {
          if (child.exitCode === null && !child.killed) {
            await Promise.race([safeRelease(), sleep(500)]);
          }
        } finally {
          try {
            child.stdin.end();
          } catch {
            // Already closed.
          }
          if (child.exitCode === null && !child.killed) {
            try {
              child.kill("SIGTERM");
            } catch {
              // Already exited.
            }
          }
        }
      },
    };
  });
}

async function acquireWorktreeAdminSession(worktreeGitDir, gitDirStat) {
  const deadline = Date.now() + INTEGRATION_LOCK_TIMEOUT_MS;
  while (true) {
    await verifyNonSymlinkDirectory(
      worktreeGitDir,
      worktreeGitDir,
      "Member worktree Git metadata directory",
    );
    const attempt = await spawnAdminSessionOnce(worktreeGitDir, gitDirStat);
    if (!attempt.busy) return attempt;
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for concurrent worktree integration lock");
    }
    await sleep(INTEGRATION_LOCK_POLL_MS);
  }
}

function snapshotDispatch(dispatch) {
  if (!isPlainObject(dispatch)) return null;
  return {
    id: dispatch.id ?? null,
    taskDir: dispatch.taskDir ?? null,
    taskId: dispatch.taskId ?? null,
    requestId: dispatch.requestId ?? null,
    runId: dispatch.runId ?? null,
    transport: dispatch.transport ?? null,
  };
}

function sameDispatch(left, right) {
  const a = snapshotDispatch(left);
  const b = snapshotDispatch(right);
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.taskDir === b.taskDir &&
    a.taskId === b.taskId &&
    a.requestId === b.requestId &&
    a.runId === b.runId &&
    a.transport === b.transport
  );
}

function runPythonStdin(script, args, stdinPayload, timeoutMs = 10_000, extraEnv = null) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-B", "-c", script, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(extraEnv && { env: { ...process.env, ...extraEnv } }),
    });
    let stdout = "";
    let stderr = "";
    let isSettled = false;
    const timer = setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      reject(new Error(`Python verification timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 2 * 1024 * 1024) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `Python exited with code ${code}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(stdinPayload));
  });
}

async function verifyCandidateFingerprint(
  worktreePath,
  result,
  committedPathsForPostCheck = null,
  rollbackTxIds = [],
  extraEnv = null,
) {
  const script = [
    "import hashlib, json, re, sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "import run_agent as runner",
    "req = json.loads(sys.stdin.read())",
    'repo = Path(req["worktree_path"])',
    'result = req["payload"]',
    'committed = req["committed"]',
    'rollback_txs = set(req.get("rollback_txs") or [])',
    "def identity_matches(repo_path, expected, allowed_txs):",
    "    current = runner.git_identity(repo_path)",
    '    for key in ("head", "branch", "branch_ref", "common_dir"):',
    "        if current.get(key) != expected.get(key):",
    "            return False",
    '    exp_reflog = expected.get("head_reflog_sha256")',
    '    if current.get("head_reflog_sha256") == exp_reflog:',
    "        return True",
    "    if not allowed_txs:",
    "        return False",
    '    raw_log = runner.git_optional_output(repo_path, "reflog", "show", "--format=%H%x00%gs", "HEAD")',
    "    lines = [line for line in raw_log.splitlines() if line]",
    "    idx = 0",
    '    rb_re = re.compile(r"^orkest:rollback:([0-9a-f-]+)$")',
    '    int_re = re.compile(r"^orkest:integrate:([0-9a-f-]+)$")',
    "    while idx + 1 < len(lines):",
    String.raw`        sha1, _, sub1 = lines[idx].partition("\x00")`,
    String.raw`        sha2, _, sub2 = lines[idx + 1].partition("\x00")`,
    "        m_rb = rb_re.match(sub1)",
    "        m_int = int_re.match(sub2)",
    '        if m_rb and m_int and m_rb.group(1) == m_int.group(1) and m_rb.group(1) in allowed_txs and sha1 == expected.get("head") and sha2:',
    "            idx += 2",
    "            continue",
    "        break",
    "    if idx == 0 or idx >= len(lines):",
    "        return False",
    '    base_sha = hashlib.sha256(lines[idx].encode("utf-8", errors="replace")).hexdigest()',
    "    return base_sha == exp_reflog",
    "if committed is None:",
    '    state = runner.git_state(repo, result.get("tracked_paths", []))',
    '    expected_tree = result["git_after"].get("tree_oid") or result["git_after"].get("tree")',
    '    tree_ok = bool(expected_tree) and state.get("tree_oid") == expected_tree',
    '    ok = (state["fingerprint"] == result["git_after"]["fingerprint"] and tree_ok and identity_matches(repo, result["git_identity_after"], rollback_txs))',
    "    print(json.dumps({'ok': ok}))",
    "else:",
    '    fps = result.get("git_after", {}).get("path_fingerprints")',
    '    expected_tree = result["git_after"].get("tree_oid") or result["git_after"].get("tree")',
    '    tree_ok = bool(expected_tree) and runner.git_state(repo, [])["tree_oid"] == expected_tree',
    "    if isinstance(fps, dict):",
    "        files_ok = all(",
    '            p in fps and runner.path_fingerprint(repo / p) == {"kind": fps[p].get("kind"), "sha256": fps[p].get("sha256")}',
    "            for p in committed",
    "        )",
    "    else:",
    "        files_ok = True",
    "    print(json.dumps({'ok': files_ok and tree_ok}))",
  ].join("\n");
  const payload = {
    tracked_paths: Array.isArray(result.tracked_paths) ? result.tracked_paths : [],
    git_after: result.git_after,
    git_identity_after: result.git_identity_after,
  };
  let stdout;
  try {
    stdout = await runPythonStdin(
      script,
      [scriptsDir],
      {
        worktree_path: worktreePath,
        payload,
        committed: committedPathsForPostCheck,
        rollback_txs: rollbackTxIds,
      },
      10_000,
      extraEnv,
    );
  } catch (error) {
    throw new Error(`Failed to verify accepted result fingerprint: ${error.message}`, {
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error("Invalid response when verifying accepted result fingerprint", {
      cause: error,
    });
  }
  if (!parsed?.ok) {
    throw new Error(
      "Member worktree state changed after acceptance and no longer matches accepted result fingerprint",
    );
  }
}

function isAncestor(exec, worktreePath, maybeAncestor, descendant) {
  const check = invokeGit(exec, worktreePath, [
    "merge-base",
    "--is-ancestor",
    maybeAncestor,
    descendant,
  ]);
  if (typeof check === "string") return true;
  return check?.status === 0;
}

function committedPathsForRange(exec, worktreePath, targetSha, mergeBase, targetCommit) {
  const perCommit = new Set();
  const revLines = gitOutput(exec, worktreePath, [
    "rev-list",
    "--parents",
    `${targetSha}..${targetCommit}`,
  ])
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  for (const line of revLines) {
    const [commitSha, ...parents] = line.split(/\s+/u);
    if (!commitSha) continue;
    if (parents.length === 0) {
      const rootDiffPaths = parseNulPaths(
        gitOutput(exec, worktreePath, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "--no-renames",
          "--root",
          "-z",
          commitSha,
        ]),
      );
      for (const item of rootDiffPaths) {
        perCommit.add(item);
      }
    } else if (parents.length === 1) {
      const parentDiffPaths = parseNulPaths(
        gitOutput(exec, worktreePath, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "--no-renames",
          "-z",
          parents[0],
          commitSha,
        ]),
      );
      for (const item of parentDiffPaths) {
        perCommit.add(item);
      }
    } else {
      // For merges, diff against target-branch ancestor parents if syncing from target,
      // otherwise diff against all parents to catch changes on merged side branches and evil merges.
      const targetParents = parents.filter((parent) =>
        isAncestor(exec, worktreePath, parent, targetSha),
      );
      const relevantParents = targetParents.length > 0 ? targetParents : parents;
      for (const parent of relevantParents) {
        const mergeDiffPaths = parseNulPaths(
          gitOutput(exec, worktreePath, [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "--no-renames",
            "-z",
            parent,
            commitSha,
          ]),
        );
        for (const item of mergeDiffPaths) {
          perCommit.add(item);
        }
      }
    }
  }
  const netDiff = parseNulPaths(
    gitOutput(exec, worktreePath, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      mergeBase,
      targetCommit,
      "--",
    ]),
  );
  return new Set([...perCommit, ...netDiff]);
}

function validateTargetAncestryAndScope(
  exec,
  repoRoot,
  worktreePath,
  targetBranch,
  candidateCommit,
  { dirtyPaths, reportedPaths, allowedPaths, requireAhead = false, clean = false },
) {
  const currentTargetSha = gitOutput(exec, repoRoot, [
    "rev-parse",
    "--verify",
    ["refs/heads/", targetBranch, "^{commit}"].join(""),
  ]).trim();
  const mergeBaseCheck = invokeGit(exec, worktreePath, [
    "merge-base",
    currentTargetSha,
    candidateCommit,
  ]);
  let mergeBase = "";
  if (typeof mergeBaseCheck === "string") {
    mergeBase = mergeBaseCheck.trim();
  } else if (mergeBaseCheck?.status === 0) {
    mergeBase = String(mergeBaseCheck.stdout ?? "").trim();
  }
  if (!mergeBase) {
    throw new Error(
      `Member worktree branch has no common merge base with ${targetBranch} (unrelated history)`,
    );
  }
  const commitsAhead = Number(
    gitOutput(exec, worktreePath, [
      "rev-list",
      "--count",
      `${currentTargetSha}..${candidateCommit}`,
    ]).trim(),
  );
  if (!Number.isSafeInteger(commitsAhead) || commitsAhead < 0) {
    throw new Error(`Could not determine commits ahead of target branch ${targetBranch}`);
  }
  if (clean && commitsAhead <= 0) {
    throw new Error(
      `Member worktree is clean and has no commits ahead of ${targetBranch}; there is nothing to integrate`,
    );
  }
  if (requireAhead && commitsAhead <= 0) {
    throw new Error(`The accepted room commit is not ahead of its target branch ${targetBranch}`);
  }
  const committedPaths =
    commitsAhead > 0
      ? committedPathsForRange(exec, worktreePath, currentTargetSha, mergeBase, candidateCommit)
      : new Set();
  const allPaths = new Set([...committedPaths, ...dirtyPaths, ...reportedPaths]);
  const outOfScope = [...allPaths].filter(
    (changedPath) => !isChangedPathAllowed(changedPath, allowedPaths),
  );
  if (outOfScope.length > 0) {
    throw new Error(`Changed paths fall outside accepted allowed_paths: ${outOfScope.join(", ")}`);
  }
  return { targetSha: currentTargetSha, mergeBase, commitsAhead, committedPaths };
}

function projectLatestDispatchRun(task, dispatch) {
  if (!isPlainObject(task) || !Array.isArray(task.runs) || !Array.isArray(task.decisions)) {
    throw new Error("Accepted member task.json is missing valid runs or decisions");
  }
  const requestId = dispatch?.requestId;
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("Accepted member dispatch has no requestId");
  }
  const matches = task.runs.filter((run) => isPlainObject(run) && run.request_id === requestId);
  if (matches.length !== 1) {
    throw new Error("Accepted member dispatch has no unique run in task.json");
  }
  const anchor = matches[0];
  if (typeof anchor.run_id !== "string" || !anchor.run_id) {
    throw new Error("Accepted anchor run has no run_id in task.json");
  }
  if (dispatch.runId && anchor.run_id !== dispatch.runId) {
    throw new Error("Accepted run identity changed in task.json");
  }
  const allowedTransports = new Set([dispatch.transport || anchor.transport, "host_checks"]);
  const candidates = task.runs.filter(
    (run) =>
      isPlainObject(run) && run.engine === anchor.engine && allowedTransports.has(run.transport),
  );
  const byId = new Map(candidates.map((run) => [run.run_id, run]));
  const byResult = new Map(
    candidates.filter((run) => run.result_path).map((run) => [run.result_path, run]),
  );
  const chain = new Set([anchor.run_id]);
  let size;
  do {
    size = chain.size;
    for (const run of candidates) {
      if (!["continue", "correction", "verification"].includes(run.kind)) continue;
      const parent =
        byId.get(run.verification_of ?? run.parent_run_id) ??
        byResult.get(run.resume_result ?? run.resumed_from);
      if (!parent || (!chain.has(run.run_id) && !chain.has(parent.run_id))) continue;
      chain.add(parent.run_id);
      chain.add(run.run_id);
    }
  } while (chain.size !== size);
  const history = candidates.filter((run) => chain.has(run.run_id));
  const latestRun = history.at(-1);
  if (!latestRun || typeof latestRun.run_id !== "string" || !latestRun.run_id) {
    throw new Error("Accepted run projection is missing latest run");
  }
  const decisions = task.decisions.filter(
    (item) => isPlainObject(item) && item.run_id === latestRun.run_id,
  );
  const verdict = decisions.length > 0 ? decisions.at(-1).decision : null;
  return { latestRun, verdict };
}

function verifyAcceptedResultSync(resultPath, expectedSha256, dispatch, acceptedRunId) {
  const bytes = readFileSync(resultPath);
  if (sha256Hex(bytes) !== expectedSha256) {
    throw new Error("Accepted member result.json changed during integration");
  }
  const taskDir = dispatch?.taskDir;
  if (typeof taskDir !== "string" || !taskDir) {
    throw new Error("Accepted member dispatch has no taskDir");
  }
  const taskPath = path.join(taskDir, "task.json");
  let taskRaw;
  try {
    taskRaw = readFileSync(taskPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Accepted member task.json is missing", { cause: error });
    }
    throw error;
  }
  const task = JSON.parse(taskRaw);
  const { latestRun, verdict } = projectLatestDispatchRun(task, dispatch);
  if (latestRun.run_id !== acceptedRunId) {
    throw new Error("Accepted run was superseded by a newer run in task.json");
  }
  if (latestRun.result_path !== resultPath || latestRun.result_sha256 !== expectedSha256) {
    throw new Error("Accepted run record or digest changed during integration");
  }
  if (verdict !== "accept") {
    throw new Error("Accepted run verdict changed during integration");
  }
}

function isExecutableHook(hookPath) {
  try {
    const info = statSync(hookPath);
    if (!info.isFile()) return false;
    accessSync(hookPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveHooksDir(exec, worktreePath) {
  const configured = invokeGit(exec, worktreePath, ["config", "--path", "--get", "core.hooksPath"]);
  let configuredRaw = "";
  if (typeof configured === "string") {
    configuredRaw = configured.trim();
  } else if (configured?.status === 0) {
    configuredRaw = String(configured.stdout ?? "").trim();
  }
  if (configuredRaw) {
    return path.isAbsolute(configuredRaw)
      ? configuredRaw
      : path.resolve(worktreePath, configuredRaw);
  }
  const defaultRaw = gitOutput(exec, worktreePath, ["rev-parse", "--git-path", "hooks"]).trim();
  return path.isAbsolute(defaultRaw) ? defaultRaw : path.resolve(worktreePath, defaultRaw);
}

function invokeHook(hookName, hookPath, args, cwd, extraEnv) {
  try {
    execFileSync(hookPath, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail =
      error.stderr?.toString().trim() ||
      error.stdout?.toString().trim() ||
      error.message ||
      `exit ${error.status ?? 1}`;
    throw new Error(`${hookName} hook failed: ${detail}`, { cause: error });
  }
}

async function runRepoCommitHooks(exec, worktreePath, privateIndexPath, message) {
  const hooksDir = resolveHooksDir(exec, worktreePath);
  const indexEnv = { GIT_INDEX_FILE: privateIndexPath };
  const preCommit = path.join(hooksDir, "pre-commit");
  if (isExecutableHook(preCommit)) {
    invokeHook("pre-commit", preCommit, [], worktreePath, indexEnv);
  }
  let finalMessage = message;
  const commitMsg = path.join(hooksDir, "commit-msg");
  if (isExecutableHook(commitMsg)) {
    const { unlink, writeFile } = await import("node:fs/promises");
    const msgPath = path.join(path.dirname(privateIndexPath), "COMMIT_EDITMSG");
    await writeFile(msgPath, `${message}\n`, { mode: 0o600 });
    try {
      invokeHook("commit-msg", commitMsg, [msgPath], worktreePath, indexEnv);
      const edited = readFileSync(msgPath, "utf8").replace(/\r?\n$/u, "");
      if (!edited.trim()) {
        throw new Error("commit-msg hook produced an empty commit message");
      }
      finalMessage = edited;
    } finally {
      try {
        await unlink(msgPath);
      } catch {
        // Best-effort cleanup of temp commit message.
      }
    }
  }
  return finalMessage;
}

function runAtomicRefTransaction(
  exec,
  worktreePath,
  integrationId,
  { targetRef, expectedTargetSha, branchRef, newCommitOid, expectedCandidateOid, updateCandidate },
) {
  const lines = [
    "start",
    `verify ${targetRef} ${expectedTargetSha}`,
    updateCandidate
      ? `update ${branchRef} ${newCommitOid} ${expectedCandidateOid}`
      : `verify ${branchRef} ${expectedCandidateOid}`,
    "prepare",
    "commit",
    "",
  ];
  gitOutput(
    exec,
    worktreePath,
    ["update-ref", "-m", `orkest:integrate:${integrationId}`, "--stdin"],
    undefined,
    lines.join("\n"),
  );
}

const GIT_OID_RE = /^[0-9a-f]{40,64}$/iu;

async function resolveVerifiedLiveIndex(exec, worktreePath, worktreeGitDir) {
  const resolvedIndexRel = gitOutput(exec, worktreePath, [
    "rev-parse",
    "--git-path",
    "index",
  ]).trim();
  const liveIndexPath = path.resolve(worktreePath, resolvedIndexRel);
  const liveIndexParent = await realpath(path.dirname(liveIndexPath));
  if (!isCanonicalWithin(liveIndexParent, worktreeGitDir)) {
    throw new Error("Member worktree index path escapes registered Git metadata directory");
  }
  const liveIndexRel = path.relative(
    worktreeGitDir,
    path.join(liveIndexParent, path.basename(liveIndexPath)),
  );
  if (hasInvalidRelativeSyntax(liveIndexRel)) {
    throw new Error("Member worktree index path escapes registered Git metadata directory");
  }
  return { liveIndexPath, liveIndexRel };
}

async function reconcileIncompleteJournals(
  id,
  memberId,
  worktreePath,
  { root, exec, adminSession, worktreeGitDir },
) {
  const { journals } = await adminSession.listTxJournals();
  if (!Array.isArray(journals) || journals.length === 0) return null;
  if (journals.length > 1) {
    throw new Error("Member worktree has multiple incomplete integration transactions");
  }
  const { name: entryName, tx } = journals[0];
  const entryMatch = typeof entryName === "string" ? TX_JOURNAL_ENTRY_RE.exec(entryName) : null;
  if (!entryMatch) {
    throw new Error("Member worktree has an invalid integration transaction journal filename");
  }
  const validatedEntryId = entryMatch[1];
  if (
    !isPlainObject(tx) ||
    typeof tx.integrationId !== "string" ||
    !tx.integrationId ||
    tx.integrationId !== validatedEntryId ||
    entryName !== `integrate-tx-${validatedEntryId}.json`
  ) {
    throw new Error("Member worktree has a malformed integration transaction journal");
  }
  if (tx.roomId !== id || tx.memberId !== memberId) {
    throw new Error(
      "Member worktree has an incomplete integration transaction for another room or member",
    );
  }
  const room = await readRoom(id, root);
  const member = memberOf(room, memberId);
  if (!member.integration) {
    await adminSession.rollbackUncommittedTx(entryName);
    return null;
  }
  if (member.integration.integrationId !== tx.integrationId) {
    throw new Error(`Member ${memberId} has conflicting committed integration metadata`);
  }

  // Validate journal strictly against durable room record & verified checkout BEFORE any writes (#4).
  if (!member.worktree?.path || (await realpath(member.worktree.path)) !== worktreePath) {
    throw new Error("Member worktree changed before interrupted integration recovery");
  }
  if (
    typeof tx.worktreePath !== "string" ||
    !tx.worktreePath ||
    (await realpath(tx.worktreePath)) !== worktreePath
  ) {
    throw new Error("Integration transaction journal worktreePath does not match checkout");
  }
  const durableCommit = member.integration.commit;
  if (
    typeof durableCommit !== "string" ||
    !GIT_OID_RE.test(durableCommit) ||
    tx.commit !== durableCommit
  ) {
    throw new Error(
      "Integration transaction journal commit does not match durable room integration",
    );
  }
  const durableTargetOid = member.integration.targetOid;
  if (
    typeof durableTargetOid !== "string" ||
    !GIT_OID_RE.test(durableTargetOid) ||
    tx.expectedTargetOid !== durableTargetOid
  ) {
    throw new Error(
      "Integration transaction journal targetOid does not match durable room integration",
    );
  }
  if (typeof tx.headSha !== "string" || !GIT_OID_RE.test(tx.headSha)) {
    throw new Error("Integration transaction journal has invalid headSha");
  }
  if (typeof tx.isClean !== "boolean" || (tx.isClean && tx.headSha !== durableCommit)) {
    throw new Error("Integration transaction journal clean flag disagrees with commit");
  }

  const verifiedBranch = gitOutput(exec, worktreePath, [
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD",
  ]).trim();
  if (!verifiedBranch) {
    throw new Error("Member worktree is detached during interrupted integration recovery");
  }
  if (member.worktree.branch && member.worktree.branch !== verifiedBranch) {
    throw new Error("Member worktree branch differs from recorded room branch");
  }
  if (typeof tx.branch !== "string" || tx.branch !== verifiedBranch) {
    throw new Error("Integration transaction journal branch does not match verified checkout");
  }

  const durableTargetBranch =
    typeof member.integration.targetBranch === "string" && member.integration.targetBranch
      ? member.integration.targetBranch
      : null;
  if (
    typeof tx.targetBranch !== "string" ||
    !tx.targetBranch.trim() ||
    (durableTargetBranch && tx.targetBranch !== durableTargetBranch)
  ) {
    throw new Error(
      "Integration transaction journal targetBranch does not match durable room integration",
    );
  }
  const verifiedTargetBranch = durableTargetBranch || tx.targetBranch;
  const verifiedBranchRef = `refs/heads/${verifiedBranch}`;
  const verifiedTargetRef = `refs/heads/${verifiedTargetBranch}`;
  if (tx.branchRef !== verifiedBranchRef || tx.targetRef !== verifiedTargetRef) {
    throw new Error("Integration transaction journal ref destinations fail verification");
  }

  let verifiedIndexRel = null;
  if (!tx.isClean) {
    const resolvedIdx = await resolveVerifiedLiveIndex(exec, worktreePath, worktreeGitDir);
    verifiedIndexRel = resolvedIdx.liveIndexRel;
    if (typeof tx.liveIndexRel !== "string" || tx.liveIndexRel !== verifiedIndexRel) {
      throw new Error(
        "Integration transaction journal index path does not match checkout admin dir",
      );
    }
    if (
      tx.indexLockToken !== undefined &&
      tx.indexLockToken !== null &&
      (typeof tx.indexLockToken !== "string" || !tx.indexLockToken)
    ) {
      throw new Error("Integration transaction journal has invalid indexLockToken");
    }
  }

  if (!isPlainObject(tx.taskSpec) || !isPlainObject(tx.foundryState) || !isPlainObject(tx.marker)) {
    throw new Error("Integration transaction journal metadata payloads are malformed");
  }
  const durableTaskSpecSha256 = member.integration.taskSpecSha256;
  if (
    typeof durableTaskSpecSha256 !== "string" ||
    !SHA256_HEX_RE.test(durableTaskSpecSha256) ||
    taskSpecDigest(tx.taskSpec) !== durableTaskSpecSha256
  ) {
    throw new Error(
      "Integration transaction journal taskSpec does not match durable room integration",
    );
  }
  if (
    tx.foundryState.roomId !== id ||
    tx.foundryState.memberId !== memberId ||
    tx.foundryState.integrationId !== tx.integrationId ||
    tx.foundryState.headSha !== durableCommit ||
    tx.foundryState.branch !== verifiedBranch ||
    tx.foundryState.targetBranch !== verifiedTargetBranch ||
    typeof tx.foundryState.worktreePath !== "string" ||
    (await realpath(tx.foundryState.worktreePath)) !== worktreePath
  ) {
    throw new Error("Integration transaction journal foundryState does not match durable record");
  }
  if (
    tx.marker.roomId !== id ||
    tx.marker.memberId !== memberId ||
    tx.marker.integrationId !== tx.integrationId ||
    tx.marker.commit !== durableCommit ||
    tx.marker.branch !== verifiedBranch
  ) {
    throw new Error("Integration transaction journal marker does not match durable record");
  }

  // Room integration was durably persisted before interruption: roll forward safely using verified destinations.
  await adminSession.writeMetadata(tx.taskSpec, tx.foundryState, true);

  const currentBranchSha = gitOutput(exec, worktreePath, [
    "rev-parse",
    "--verify",
    verifiedBranchRef + "^{commit}",
  ]).trim();

  if (tx.isClean) {
    if (currentBranchSha !== durableCommit) {
      throw new Error("Member worktree branch moved externally during interrupted integration");
    }
  } else {
    if (currentBranchSha === tx.headSha) {
      gitOutput(exec, worktreePath, ["rev-parse", "--verify", durableCommit + "^{commit}"]);
      runAtomicRefTransaction(exec, worktreePath, tx.integrationId, {
        targetRef: verifiedTargetRef,
        expectedTargetSha: durableTargetOid,
        branchRef: verifiedBranchRef,
        newCommitOid: durableCommit,
        expectedCandidateOid: tx.headSha,
        updateCandidate: true,
      });
    } else if (currentBranchSha !== durableCommit) {
      throw new Error("Member worktree branch moved externally during interrupted integration");
    }

    const liveStat = await adminSession.statLiveIndex(verifiedIndexRel);
    const liveMatchesOriginal =
      (!liveStat.exists && tx.originalIndexSha256 == null) ||
      (liveStat.exists && liveStat.sha256 === tx.originalIndexSha256);

    if (liveMatchesOriginal) {
      const recPrivIdx = await adminSession.writePrivateIndex(null);
      try {
        const indexEnv = { GIT_INDEX_FILE: recPrivIdx.path };
        gitOutput(exec, worktreePath, ["read-tree", durableCommit + "^{tree}"], indexEnv);
        if (
          gitOutput(
            exec,
            worktreePath,
            ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"],
            indexEnv,
          ).trim()
        ) {
          throw new Error("Interrupted integration worktree no longer matches committed tree");
        }
        await adminSession.swapIndex(
          recPrivIdx.name,
          verifiedIndexRel,
          tx.originalIndexSha256,
          recPrivIdx.dir_name,
          {
            integrationId: tx.integrationId,
            lockToken: tx.indexLockToken || null,
            reclaimLockToken: tx.indexLockToken || null,
          },
        );
      } catch (error) {
        try {
          await adminSession.cleanupPrivateIndex(recPrivIdx.name, recPrivIdx.dir_name);
        } catch {
          // Best-effort cleanup.
        }
        throw error;
      }
    } else {
      await adminSession.reclaimAbandonedIndexLock(
        verifiedIndexRel,
        tx.integrationId,
        tx.indexLockToken || null,
      );
      const liveDirty = gitOutput(exec, worktreePath, [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]).trim();
      const cachedDiff = invokeGit(exec, worktreePath, [
        "diff-index",
        "--cached",
        "--quiet",
        durableCommit,
      ]);
      const isCachedClean = typeof cachedDiff === "string" || cachedDiff?.status === 0;
      if (liveDirty || !isCachedClean) {
        throw new Error(
          "Member worktree index changed concurrently during interrupted integration",
        );
      }
    }
  }

  const { marker: existingMarker } = await adminSession.readMarker();
  if (!existingMarker) {
    await adminSession.writeMarker(tx.marker, true);
  } else if (existingMarker.integrationId !== tx.integrationId) {
    throw new Error("Member worktree has conflicting orkest.json marker");
  }

  await adminSession.clearRollbackTx();
  await adminSession.deleteTxJournal({ name: entryName });

  return {
    roomId: id,
    memberId,
    worktreePath,
    branch: verifiedBranch,
    targetBranch: verifiedTargetBranch,
    integration: member.integration,
    foundryState: tx.foundryState,
  };
}

/** Commit or reuse a reviewed, accepted room result and register it with the smelter queue. */
export async function integrateMemberWorktree(id, memberId, options = {}) {
  const {
    root = mailboxRoot(),
    run = coordinator,
    exec,
    message,
    updateRoom: persistRoom = updateRoom,
  } = options;
  if (!isValidCommitSubject(message))
    throw new Error(
      "--message must be a single-line conventional commit subject (type(scope)?: text)",
    );

  const initialRoom = await readRoom(id, root);
  const initialMember = memberOf(initialRoom, memberId);
  if (!initialMember.worktree?.path)
    throw new Error(`Member ${memberId} has no recorded room worktree`);
  if (initialMember.worktree.disposable !== true)
    throw new Error(
      `Member ${memberId} worktree is not disposable and cannot enter the smelter queue`,
    );

  const repoRoot = await realpath(initialRoom.cwd);
  const worktreePath = await realpath(initialMember.worktree.path);
  if (worktreePath === repoRoot) throw new Error("Room worktree resolves to the room checkout");
  if ((await realpath(resolveRepositoryRoot(worktreePath, exec))) !== worktreePath)
    throw new Error("Recorded member path is not a Git worktree root");

  const listedWorktrees = gitOutput(exec, repoRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
  const registered = await Promise.all(
    listedWorktrees.map(async (candidate) => {
      try {
        return (await realpath(candidate)) === worktreePath;
      } catch {
        return false;
      }
    }),
  );
  if (!registered.includes(true))
    throw new Error("Recorded path is not registered to the room repository");

  const rootCommonDir = await realpath(
    path.resolve(repoRoot, gitOutput(exec, repoRoot, ["rev-parse", "--git-common-dir"]).trim()),
  );
  const worktreeCommonDir = await realpath(
    path.resolve(
      worktreePath,
      gitOutput(exec, worktreePath, ["rev-parse", "--git-common-dir"]).trim(),
    ),
  );
  if (rootCommonDir !== worktreeCommonDir)
    throw new Error("Recorded worktree belongs to a different Git repository");

  const { worktreeGitDir, markerPath, gitDirHandle, gitDirStat } = await verifyWorktreeAdminDir(
    worktreePath,
    worktreeCommonDir,
    exec,
  );
  let adminSession = null;
  let privateIndex = null;

  try {
    adminSession = await acquireWorktreeAdminSession(worktreeGitDir, gitDirStat);
    const recovered = await reconcileIncompleteJournals(id, memberId, worktreePath, {
      root,
      exec,
      adminSession,
      worktreeGitDir,
    });
    if (recovered) return recovered;

    const storedRoom = await readRoom(id, root);
    const storedMember = memberOf(storedRoom, memberId);
    if (storedMember.integration) throw new Error(`Member ${memberId} is already integrated`);
    if (
      !storedMember.worktree?.path ||
      (await realpath(storedMember.worktree.path)) !== worktreePath
    )
      throw new Error("Member worktree changed before integration");
    if (storedMember.worktree.disposable !== true)
      throw new Error(
        `Member ${memberId} worktree is not disposable and cannot enter the smelter queue`,
      );
    const acceptedDispatch = snapshotDispatch(storedMember.dispatch);

    // Where the result belongs: an explicit target, else the branch the worktree was created from,
    // else the branch the room checkout is on now. Never a guessed default.
    const targetBranch =
      options.target || storedMember.worktree.baseBranch || currentBranch(repoRoot, exec);
    if (!targetBranch)
      throw new Error(
        "Cannot tell which branch this result belongs on: the room checkout is detached; pass --target BRANCH",
      );

    const observedRoom = await observeRoom(storedRoom, { root, run });
    const observedMember = memberOf(observedRoom, memberId);
    if (observedMember.verdict !== "accept")
      throw new Error(`Member ${memberId} must have an accepted result before integration`);
    if (observedMember.evidenceState === "stale")
      throw new Error(`Member ${memberId} accepted evidence is stale`);
    if (observedMember.worktree?.path !== storedMember.worktree.path)
      throw new Error("Observed member worktree differs from the recorded worktree");
    if (!observedMember.resultPath)
      throw new Error("Accepted member result has no result.json path");
    if (typeof observedMember.runId !== "string" || !observedMember.runId)
      throw new Error("Accepted member result has no runId");
    const acceptedRunId = observedMember.runId;
    const acceptedResultPath = observedMember.resultPath;
    const acceptedObjective = observedMember.objective;

    const resultRecord = await readResultRecord(acceptedResultPath);
    if (!resultRecord) throw new Error("Accepted member result.json is missing or invalid");
    const { result, sha256: acceptedResultSha256 } = resultRecord;
    if (
      typeof result.repository !== "string" ||
      (await realpath(result.repository)) !== worktreePath
    )
      throw new Error("Accepted result repository differs from the member worktree");
    if (
      !Array.isArray(result.allowed_paths) ||
      result.allowed_paths.length === 0 ||
      result.allowed_paths.some((item) => !isValidAllowedPath(item))
    )
      throw new Error("Accepted result has no valid allowed_paths scope");
    if (
      !Array.isArray(result.verification_commands) ||
      result.verification_commands.length === 0 ||
      result.verification_commands.some((item) => !(typeof item === "string" && item.trim()))
    )
      throw new Error("Accepted result has no valid verification_commands");
    if (
      !Array.isArray(result.run_delta?.changed_paths) ||
      result.run_delta.changed_paths.some((item) => typeof item !== "string")
    )
      throw new Error("Accepted result has no valid run_delta.changed_paths");
    if (result.engine !== observedMember.engine || result.model !== observedMember.resolvedModel)
      throw new Error("Accepted result engine or model differs from the observed room run");
    if (typeof acceptedObjective !== "string" || !acceptedObjective.trim())
      throw new Error("Accepted room task has no objective for the smelter task spec");
    let acceptedTreeOid = null;
    if (typeof result.git_after?.tree_oid === "string" && result.git_after.tree_oid.trim()) {
      acceptedTreeOid = result.git_after.tree_oid.trim();
    } else if (typeof result.git_after?.tree === "string" && result.git_after.tree.trim()) {
      acceptedTreeOid = result.git_after.tree.trim();
    }
    if (
      typeof result.git_after?.fingerprint === "string" &&
      result.git_after.fingerprint.trim() &&
      !acceptedTreeOid &&
      isPlainObject(result.git_identity_after)
    ) {
      throw new Error(
        "Accepted result has a legacy pre-tree receipt missing git_after.tree_oid; run coordinator reverify first",
      );
    }
    if (
      typeof result.git_after?.fingerprint !== "string" ||
      !result.git_after.fingerprint.trim() ||
      !acceptedTreeOid ||
      !isPlainObject(result.git_identity_after)
    )
      throw new Error(
        "Accepted result has no valid git_after fingerprint, tree_oid, or git_identity_after",
      );
    const matchingRun = Array.isArray(observedMember.runHistory)
      ? observedMember.runHistory.find((entry) => entry?.run_id === acceptedRunId)
      : null;
    if (
      matchingRun?.candidate?.fingerprint &&
      matchingRun.candidate.fingerprint !== result.git_after.fingerprint
    )
      throw new Error("Accepted run candidate fingerprint disagrees with result.json");
    if (matchingRun?.candidate?.tree_oid && matchingRun.candidate.tree_oid !== acceptedTreeOid)
      throw new Error("Accepted run candidate tree_oid disagrees with result.json");

    const branch = gitOutput(exec, worktreePath, ["symbolic-ref", "--short", "-q", "HEAD"]).trim();
    if (!branch) throw new Error("Member worktree is detached and cannot be integrated");
    if (storedMember.worktree.branch && storedMember.worktree.branch !== branch)
      throw new Error("Member worktree branch differs from the recorded room branch");
    if (branch === targetBranch) throw new Error("Member worktree is on its own target branch");

    const headSha = gitOutput(exec, worktreePath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]).trim();
    const unmerged = parseNulPaths(gitOutput(exec, worktreePath, ["ls-files", "--unmerged", "-z"]));
    if (unmerged.length > 0)
      throw new Error("Member worktree has unmerged index entries and cannot be integrated");
    for (const gitState of [
      "MERGE_HEAD",
      "REVERT_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ]) {
      const gitStatePath = path.resolve(
        worktreePath,
        gitOutput(exec, worktreePath, ["rev-parse", "--git-path", gitState]).trim(),
      );
      if (await pathExists(gitStatePath))
        throw new Error(
          `Member worktree has an in-progress Git operation (${gitState}) and cannot be integrated`,
        );
    }

    const gitStatus = gitOutput(exec, worktreePath, [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const isClean = !gitStatus.trim();
    const dirtyPaths = isClean
      ? []
      : [
          ...parseNulPaths(
            gitOutput(exec, worktreePath, ["diff", "--name-only", "--no-renames", "-z", "HEAD"]),
          ),
          ...parseNulPaths(
            gitOutput(exec, worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
          ),
        ];

    validateTargetAncestryAndScope(exec, repoRoot, worktreePath, targetBranch, headSha, {
      dirtyPaths,
      reportedPaths: result.run_delta.changed_paths,
      allowedPaths: result.allowed_paths,
      clean: isClean,
    });

    if (
      typeof result.git_identity_after.head === "string" &&
      result.git_identity_after.head !== headSha
    )
      throw new Error("Member worktree HEAD no longer matches accepted git_identity_after.head");
    if (
      typeof result.git_identity_after.branch === "string" &&
      result.git_identity_after.branch &&
      result.git_identity_after.branch !== branch
    )
      throw new Error(
        "Member worktree branch no longer matches accepted git_identity_after.branch",
      );
    if (
      typeof result.git_identity_after.common_dir === "string" &&
      result.git_identity_after.common_dir &&
      (await realpath(result.git_identity_after.common_dir)) !== worktreeCommonDir
    )
      throw new Error("Accepted result common_dir differs from member worktree repository");

    if (!isClean) {
      // Refuse before staging if either identity is unavailable; never synthesize a name or email.
      for (const identity of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
        const check = invokeGit(exec, worktreePath, ["var", identity]);
        if (typeof check !== "string" && (!check || check.status !== 0))
          throw new Error("Cannot integrate: Git author and committer identity must be configured");
      }
    }

    const taskSpecPath = resolveTaskSpecPath(worktreePath);
    const statePath = resolveFoundryStatePath(worktreePath);
    const orkestDir = path.dirname(taskSpecPath);
    if (await pathExists(orkestDir)) await verifyOrkestDirSafety(orkestDir, worktreeGitDir);
    if (
      (await pathExists(markerPath)) ||
      (await pathExists(taskSpecPath)) ||
      (await pathExists(statePath))
    )
      throw new Error("Member worktree already has Orkest merge-queue metadata");

    // Capture liveIndexSnapshot BEFORE verifyAcceptedResultSync and verifyCandidateFingerprint (#3).
    let liveIndexRel = null;
    let originalIndexBytes = null;
    let originalIndexSha256 = null;
    if (!isClean) {
      let liveIndexPath;
      ({ liveIndexPath, liveIndexRel } = await resolveVerifiedLiveIndex(
        exec,
        worktreePath,
        worktreeGitDir,
      ));
      if (await pathExists(liveIndexPath)) {
        const idxStat = await lstat(liveIndexPath);
        if (idxStat.isSymbolicLink() || !idxStat.isFile()) {
          throw new Error("Member worktree index is invalid or a symlink");
        }
      }
      try {
        originalIndexBytes = await readFile(liveIndexPath);
        originalIndexSha256 = sha256Hex(originalIndexBytes);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new Error(
            `Cannot snapshot the member worktree index before integration: ${error.message}`,
            { cause: error },
          );
        }
        originalIndexBytes = null;
        originalIndexSha256 = null;
      }
      privateIndex = await adminSession.writePrivateIndex(
        originalIndexBytes && originalIndexBytes.length > 0 ? originalIndexBytes : null,
      );
    }

    const initialTaskDir = storedMember.dispatch?.taskDir;
    if (
      typeof initialTaskDir === "string" &&
      initialTaskDir &&
      (await pathExists(initialTaskDir))
    ) {
      await adminSession.acquireTaskLock(initialTaskDir);
    }
    try {
      verifyAcceptedResultSync(
        acceptedResultPath,
        acceptedResultSha256,
        storedMember.dispatch,
        acceptedRunId,
      );
    } finally {
      await adminSession.releaseTaskLock();
    }

    const { txIds: rollbackTxIds } = await adminSession.readRollbackTxs();
    // Verify captured liveIndexSnapshot + workspace fingerprint, tree_oid & identity match before touching anything.
    await verifyCandidateFingerprint(
      worktreePath,
      result,
      null,
      rollbackTxIds,
      privateIndex ? { GIT_INDEX_FILE: privateIndex.path } : null,
    );

    if (isClean) {
      const headTree = gitOutput(exec, worktreePath, [
        "rev-parse",
        "--verify",
        "HEAD^{tree}",
      ]).trim();
      if (headTree !== acceptedTreeOid) {
        throw new Error("Member worktree tree no longer matches accepted git_after.tree_oid");
      }
    }

    // Re-verify the exact accepted room observation before committing or publishing.
    const latestRoom = await readRoom(id, root);
    const latestMember = memberOf(latestRoom, memberId);
    if (latestMember.integration) throw new Error(`Member ${memberId} is already integrated`);
    if (latestMember.worktree?.path !== storedMember.worktree.path)
      throw new Error("Member worktree changed before integration");
    if (!sameDispatch(latestMember.dispatch, acceptedDispatch))
      throw new Error("Member dispatch changed before integration");
    const latestObserved = await observeRoom(latestRoom, { root, run });
    const latestObservedMember = memberOf(latestObserved, memberId);
    if (
      latestObservedMember.verdict !== "accept" ||
      latestObservedMember.evidenceState === "stale" ||
      latestObservedMember.runId !== acceptedRunId ||
      latestObservedMember.resultPath !== acceptedResultPath ||
      latestObservedMember.objective !== acceptedObjective ||
      latestObservedMember.engine !== result.engine ||
      latestObservedMember.resolvedModel !== result.model
    ) {
      throw new Error(`Member ${memberId} accepted evidence changed before integration`);
    }
    const latestResultRecord = await readResultRecord(acceptedResultPath);
    if (!latestResultRecord || latestResultRecord.sha256 !== acceptedResultSha256) {
      throw new Error("Accepted member result.json changed before integration");
    }

    const integrationId = randomUUID();
    const indexLockToken = isClean ? null : randomUUID();
    const at = new Date().toISOString();

    let isRefMoved = false;
    let isRoomPersisted = false;
    let isRoomCompensated = false;
    let isIndexSwapped = false;
    let isJournalWritten = false;
    let installedIndexSha256 = null;
    let commit;
    let commitMessage = message;
    let commitsAhead;
    let expectedTargetSha;
    const branchRef = `refs/heads/${branch}`;
    const targetRef = `refs/heads/${targetBranch}`;
    try {
      if (isClean) {
        commit = headSha;
      } else {
        const indexEnv = { GIT_INDEX_FILE: privateIndex.path };
        gitOutput(exec, worktreePath, ["add", "-A"], indexEnv);
        const candidateTreeSha = gitOutput(exec, worktreePath, ["write-tree"], indexEnv).trim();
        if (!candidateTreeSha)
          throw new Error("Could not construct candidate tree for integration");
        if (candidateTreeSha !== acceptedTreeOid) {
          throw new Error("Staged candidate tree does not match accepted git_after.tree_oid");
        }
        const stagedPaths = parseNulPaths(
          gitOutput(
            exec,
            worktreePath,
            ["diff-index", "--cached", "--name-only", "--no-renames", "-z", "HEAD"],
            indexEnv,
          ),
        );
        const outOfScopeStaged = stagedPaths.filter(
          (stagedPath) => !isChangedPathAllowed(stagedPath, result.allowed_paths),
        );
        if (outOfScopeStaged.length > 0) {
          throw new Error(
            `Staged paths fall outside accepted allowed_paths: ${outOfScopeStaged.join(", ")}`,
          );
        }
        const uncapturedDirty = [
          ...parseNulPaths(
            gitOutput(exec, worktreePath, ["diff-files", "--name-only", "-z"], indexEnv),
          ),
          ...parseNulPaths(
            gitOutput(
              exec,
              worktreePath,
              ["ls-files", "--others", "--exclude-standard", "-z"],
              indexEnv,
            ),
          ),
        ];
        if (uncapturedDirty.length > 0) {
          throw new Error("Member worktree changed while staging accepted integration tree");
        }

        // Run repository pre-commit & commit-msg hooks against the private index before commit-tree (#12).
        commitMessage = await runRepoCommitHooks(exec, worktreePath, privateIndex.path, message);
        const postHookTreeSha = gitOutput(exec, worktreePath, ["write-tree"], indexEnv).trim();
        if (postHookTreeSha !== acceptedTreeOid) {
          throw new Error("Commit hook modified staged tree away from accepted git_after.tree_oid");
        }
        const postHookUncaptured = [
          ...parseNulPaths(
            gitOutput(exec, worktreePath, ["diff-files", "--name-only", "-z"], indexEnv),
          ),
          ...parseNulPaths(
            gitOutput(
              exec,
              worktreePath,
              ["ls-files", "--others", "--exclude-standard", "-z"],
              indexEnv,
            ),
          ),
        ];
        if (postHookUncaptured.length > 0) {
          throw new Error("Commit hook modified working tree during integration");
        }

        commit = gitOutput(
          exec,
          worktreePath,
          ["commit-tree", candidateTreeSha, "-p", headSha, "-m", commitMessage],
          indexEnv,
        ).trim();
        if (!commit) throw new Error("Could not create accepted room commit");
        const committedTreeSha = gitOutput(exec, worktreePath, [
          "rev-parse",
          "--verify",
          commit + "^{tree}",
        ]).trim();
        if (committedTreeSha !== candidateTreeSha) {
          throw new Error("Committed tree does not match verified staged tree");
        }
        const diffPaths = parseNulPaths(
          gitOutput(exec, worktreePath, [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "--no-renames",
            "-z",
            headSha,
            commit,
          ]),
        );
        const outOfScopeCommitted = diffPaths.filter(
          (item) => !isChangedPathAllowed(item, result.allowed_paths),
        );
        if (outOfScopeCommitted.length > 0) {
          throw new Error(
            `Committed paths fall outside accepted allowed_paths: ${outOfScopeCommitted.join(", ")}`,
          );
        }
        await verifyCandidateFingerprint(worktreePath, result, diffPaths);
      }

      // Immediately before publication, revalidate target SHA, ancestry, and full per-commit scope.
      ({ targetSha: expectedTargetSha, commitsAhead } = validateTargetAncestryAndScope(
        exec,
        repoRoot,
        worktreePath,
        targetBranch,
        commit,
        {
          dirtyPaths: [],
          reportedPaths: result.run_delta.changed_paths,
          allowedPaths: result.allowed_paths,
          requireAhead: true,
        },
      ));

      const currentCandidateRef = gitOutput(exec, worktreePath, [
        "rev-parse",
        "--verify",
        branchRef + "^{commit}",
      ]).trim();
      if (currentCandidateRef !== headSha) {
        throw new Error("Member worktree branch moved before integration publication");
      }
      const currentTargetRef = gitOutput(exec, repoRoot, [
        "rev-parse",
        "--verify",
        targetRef + "^{commit}",
      ]).trim();
      if (currentTargetRef !== expectedTargetSha) {
        throw new Error(`Target branch ${targetBranch} moved before integration publication`);
      }

      const verifyCommand = result.verification_commands.join(" && ");
      const taskSpec = {
        schema: "agent-executor.task-spec.v1",
        objective: acceptedObjective,
        allow_paths: result.allowed_paths,
        development_checks: result.verification_commands,
        verify_command: verifyCommand,
        engine: result.engine,
        model: result.model,
      };
      const slug = storedMember.worktree.slug || path.basename(worktreePath);
      const foundryState = buildFoundryState(worktreePath, {
        branch,
        commitsAhead,
        headSha: commit,
        integrationId,
        lastRun: {
          engine: result.engine,
          model: result.model,
          resultPath: acceptedResultPath,
        },
        mailboxRoot: path.resolve(root),
        maxAttempts: 2,
        memberId,
        roomId: id,
        status: "verified",
        targetBranch,
        verifyCommand,
        worktreePath,
        worktreeSlug: slug,
      });
      const marker = {
        branch,
        commit,
        createdAt: at,
        disposable: true,
        engine: result.engine,
        integrationId,
        mailboxRoot: path.resolve(root),
        memberId,
        parentCwd: repoRoot,
        roomId: id,
        slug,
      };
      const integration = {
        integrationId,
        commit,
        targetBranch,
        targetOid: expectedTargetSha,
        taskSpecSha256: taskSpecDigest(taskSpec),
        message: commitMessage,
        at,
      };
      const txJournal = {
        schema: "ork.integrate.tx.v1",
        integrationId,
        roomId: id,
        memberId,
        worktreePath,
        branch,
        branchRef,
        targetBranch,
        targetRef,
        expectedTargetOid: expectedTargetSha,
        headSha,
        commit,
        isClean,
        message: commitMessage,
        at,
        liveIndexRel,
        indexLockToken,
        originalIndexSha256,
        taskSpec,
        foundryState,
        marker,
      };

      // Write durable transaction journal BEFORE metadata/room writes for crash recovery (#1).
      await adminSession.writeTxJournal(txJournal);
      isJournalWritten = true;

      // Write task-spec.json and foundry-state.json anchored inside pinned git_dir_fd (no orkest.json marker yet).
      await adminSession.writeMetadata(taskSpec, foundryState);

      // Hold per-task task.json.lock across final verifyAcceptedResultSync + persistRoom (#8).
      const lockTaskDir = latestMember.dispatch?.taskDir || storedMember.dispatch?.taskDir;
      if (typeof lockTaskDir === "string" && lockTaskDir && (await pathExists(lockTaskDir))) {
        await adminSession.acquireTaskLock(lockTaskDir);
      }
      try {
        await persistRoom(
          id,
          (current) => {
            const currentMember = memberOf(current, memberId);
            if (currentMember.integration)
              throw new Error(`Member ${memberId} is already integrated`);
            if (currentMember.worktree?.path !== storedMember.worktree.path)
              throw new Error("Member worktree changed during integration");
            if (!sameDispatch(currentMember.dispatch, acceptedDispatch))
              throw new Error("Member dispatch changed during integration");
            verifyAcceptedResultSync(
              acceptedResultPath,
              acceptedResultSha256,
              currentMember.dispatch,
              acceptedRunId,
            );
            currentMember.integration = integration;
            return current;
          },
          { root },
        );
      } finally {
        await adminSession.releaseTaskLock();
      }
      isRoomPersisted = true;

      // Verify target OID and update candidate branch ref atomically in one git update-ref transaction (#9).
      runAtomicRefTransaction(exec, worktreePath, integrationId, {
        targetRef,
        expectedTargetSha,
        branchRef,
        newCommitOid: commit,
        expectedCandidateOid: headSha,
        updateCandidate: !isClean,
      });
      if (!isClean) {
        isRefMoved = true;

        const indexEnv = { GIT_INDEX_FILE: privateIndex.path };
        if (
          gitOutput(
            exec,
            worktreePath,
            ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"],
            indexEnv,
          ).trim()
        ) {
          throw new Error("Git commit left the member worktree dirty");
        }

        // Acquire Git's native index.lock inside git_dir_fd, verify live index matches captured snapshot, and swap atomically.
        const swapRes = await adminSession.swapIndex(
          privateIndex.name,
          liveIndexRel,
          originalIndexSha256,
          privateIndex.dir_name,
          { integrationId, lockToken: indexLockToken },
        );
        installedIndexSha256 = swapRes.installedSha256;
        privateIndex = null;
        isIndexSwapped = true;
      }

      // Publish discovery marker LAST after room record, branch ref, and live index are all durable.
      await adminSession.writeMarker(marker);
      await adminSession.clearRollbackTx();
      await adminSession.deleteTxJournal(integrationId);
      isJournalWritten = false;

      return {
        roomId: id,
        memberId,
        worktreePath,
        branch,
        targetBranch,
        integration,
        foundryState,
      };
    } catch (error) {
      // 1. Remove marker & metadata files via dir_fd ownership evidence so smelter never discovers a rolled-back candidate.
      try {
        await adminSession.rollbackMetadata();
      } catch {
        // Best-effort rollback.
      }
      // 2. Restore live index if swapped before failure.
      if (isIndexSwapped && installedIndexSha256 && liveIndexRel) {
        try {
          await adminSession.restoreIndex(originalIndexBytes, installedIndexSha256, liveIndexRel);
        } catch {
          // Best-effort rollback.
        }
      }
      // 3. Atomically roll back branch ref ONLY if it still points to our created commit.
      if (isRefMoved) {
        try {
          const currentRef = invokeGit(exec, worktreePath, [
            "rev-parse",
            "--verify",
            branchRef + "^{commit}",
          ]);
          let currentRefSha = "";
          if (typeof currentRef === "string") {
            currentRefSha = currentRef.trim();
          } else if (currentRef?.status === 0) {
            currentRefSha = String(currentRef.stdout ?? "").trim();
          }
          if (currentRefSha === commit) {
            gitOutput(exec, worktreePath, [
              "update-ref",
              "-m",
              `orkest:rollback:${integrationId}`,
              branchRef,
              headSha,
              commit,
            ]);
            await adminSession.recordRollbackTx(integrationId);
          }
        } catch {
          // Best-effort rollback; never overwrite an external commit.
        }
      }
      // 4. Compensate persisted room integration via CAS on our integrationId so retries are not blocked.
      if (isRoomPersisted) {
        try {
          await persistRoom(
            id,
            (current) => {
              const currentMember = memberOf(current, memberId);
              if (currentMember.integration?.integrationId === integrationId) {
                delete currentMember.integration;
              }
              return current;
            },
            { root },
          );
          isRoomCompensated = true;
        } catch {
          // Best-effort compensation.
        }
      }
      if (isJournalWritten && (!isRoomPersisted || isRoomCompensated)) {
        try {
          await adminSession.deleteTxJournal(integrationId);
        } catch {
          // Best-effort cleanup.
        }
      }
      throw error;
    }
  } finally {
    if (privateIndex && adminSession) {
      try {
        await adminSession.cleanupPrivateIndex(privateIndex.name, privateIndex.dir_name);
      } catch {
        // Best-effort cleanup of private temporary index.
      }
    }
    if (adminSession) {
      await adminSession.release();
    }
    await gitDirHandle.close();
  }
}
