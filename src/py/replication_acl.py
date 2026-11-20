"""Read and publish SSH peer authorizations beneath a verified directory descriptor."""

import contextlib
import errno
import os
import secrets
import stat
from pathlib import Path

from replication_protocol import SyncError
from replication_transport import encode_frame, read_request

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY
NOFOLLOW = os.O_NOFOLLOW


def next_directory(parent, name, *, create, system_alias):
    try:
        return os.open(name, DIRECTORY | NOFOLLOW, dir_fd=parent)
    except FileNotFoundError:
        if not create:
            raise
        with contextlib.suppress(FileExistsError):
            os.mkdir(name, 0o700, dir_fd=parent)
        return os.open(name, DIRECTORY | NOFOLLOW, dir_fd=parent)
    except OSError as exc:
        if exc.errno not in (errno.ENOTDIR, errno.ELOOP):
            raise
        # macOS /var and /tmp, and immutable Linux /home, can be system-managed aliases.
        # Only the system administrator may replace the link or entries in its parent.
        directory = os.fstat(parent)
        entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (
            system_alias
            and directory.st_uid == 0
            and not directory.st_mode & 0o022
            and entry.st_uid == 0
            and stat.S_ISLNK(entry.st_mode)
        ):
            return os.open(name, DIRECTORY, dir_fd=parent)
        raise SyncError("unsafe_peer_directory") from exc


@contextlib.contextmanager
def peer_directory(path: Path, *, create: bool = False):
    absolute = path.absolute()
    if ".." in absolute.parts or absolute.name != "sync-peers":
        raise SyncError("unsafe_peer_directory")
    fd = os.open(absolute.anchor, DIRECTORY)
    try:
        for index, name in enumerate(absolute.parts[1:], start=1):
            child = next_directory(fd, name, create=create, system_alias=index == 1 and name in {"tmp", "var", "home"})
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if index == len(absolute.parts) - 1:
                if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                    raise SyncError("unsafe_peer_directory")
            elif info.st_uid not in (0, os.geteuid()) or (
                info.st_mode & 0o022
                and not (index < len(absolute.parts) - 2 and info.st_uid == 0 and info.st_mode & stat.S_ISVTX)
            ):
                raise SyncError("unsafe_peer_directory")
        yield fd
    finally:
        os.close(fd)


def read_pair_at(directory, name):
    try:
        fd = os.open(name, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise SyncError("unsafe_peer_file") from exc
        raise
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise SyncError("unsafe_peer_file")
        return read_request(source)


def read_pair(file: Path):
    with peer_directory(file.parent) as directory:
        return read_pair_at(directory, file.name)


def save_pair(file: Path, item: dict) -> None:
    frame = encode_frame(item)
    with peer_directory(file.parent, create=True) as directory:
        temporary = ".pair-" + secrets.token_hex(16)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(frame)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, file.name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            except FileExistsError:
                if read_pair_at(directory, file.name) != item:
                    raise SyncError("peer_already_paired") from None
        finally:
            os.unlink(temporary, dir_fd=directory)
        os.fsync(directory)
