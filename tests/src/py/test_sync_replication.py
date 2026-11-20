"""Wire and peer-scope regressions independent of SSH provider availability."""

import asyncio
import io
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

ROOT = next(base for base in Path(__file__).resolve().parents if (base / "scripts/test.sh").is_file())
sys.path.insert(0, str(ROOT / "src/py"))
from replication_protocol import PROTOCOL, Peer, SyncError, pull, serve_request  # noqa: E402
from replication_transport import (  # noqa: E402
    MAX_FRAME_BYTES,
    ReplicationError,
    decode_frame,
    encode_frame,
    read_request,
    read_ssh_request,
)


class SyncWireTests(unittest.TestCase):
    def test_round_trip_accepts_unicode_and_rejects_incomplete_or_ambiguous_frames(self):
        self.assertEqual(read_request(io.BytesIO(encode_frame({"name": "Québec"}))), {"name": "Québec"})
        for wire in (
            b"{}",
            b"{}\n{}\n",
            b'{"a":1,"a":2}\n',
            b'{"a":1e999}\n',
            b'{"a":NaN}\n',
            b"null\n",
            b'{"x":"\xff"}\n',
            b"x" * MAX_FRAME_BYTES + b"\n",
        ):
            with self.subTest(wire=wire[:30]), self.assertRaises(ReplicationError):
                read_request(io.BytesIO(wire))
        self.assertEqual(decode_frame(b'{"x":0.25}\n')["x"], 0.25)

    def test_ssh_reader_times_out_when_a_peer_keeps_the_request_open(self):
        reader, writer = os.pipe()
        with os.fdopen(reader, "rb") as stream, os.fdopen(writer, "wb", buffering=0) as sink:
            sink.write(encode_frame({"ready": True}))
            with self.assertRaisesRegex(ReplicationError, "deadline"):
                read_ssh_request(stream.fileno(), timeout=0.025)

    def test_peer_scope_and_version_checked_before_any_database_access(self):
        receive = Peer("source", "source", "epoch1", frozenset({"allowed"}))
        api = SimpleNamespace(
            OutboxError=RuntimeError,
            is_exportable_scope=lambda scope: not scope.startswith("local:"),
            local_stream=Mock(side_effect=AssertionError),
        )
        base = dict(
            protocol=PROTOCOL,
            scope="allowed",
            caller="source",
            caller_epoch="epoch1",
            op="page",
            origin="dest",
            epoch="epoch2",
            after=0,
        )
        for fields, code in (
            ({"scope": "private"}, "unauthorized"),
            ({"scope": "local:private"}, "private_scope"),
            ({"caller_epoch": "new"}, "unauthorized"),
            ({"protocol": "future"}, "unsupported_version"),
            ({"peer": "somebody"}, "invalid_request"),
        ):
            self.assertEqual(serve_request(api, Path("."), receive, base | fields)["error"], code)
        api.local_stream.assert_not_called()

    def test_wrong_source_or_position_never_advances_cursor(self):
        peer = Peer("b", "B", "epochB", frozenset({"room:one"}))
        api = SimpleNamespace(
            is_exportable_scope=lambda scope: True,
            local_stream=lambda *args: {"origin": "A", "epoch": "epochA"},
            read_cursor=lambda *args, **kwargs: 4,
            apply_page=Mock(side_effect=AssertionError),
        )

        async def exercise(bad):
            async def exchange(_query):
                page = dict(origin="B", epoch="epochB", scope="room:one", after=4, through=4, more=False, events=[])
                return {"protocol": PROTOCOL, "op": "page", "data": page | bad}

            await pull(api, Path("."), peer, "room:one", exchange)

        for case in (
            {"epoch": "rotated"},
            {"scope": "elsewhere"},
            {"after": False},
            {"after": 3},
            {"through": 3},
            {"more": True},
        ):
            with self.subTest(case=case), self.assertRaises(SyncError):
                asyncio.run(exercise(case))
        api.apply_page.assert_not_called()
