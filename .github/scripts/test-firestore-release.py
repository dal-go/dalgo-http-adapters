"""Exercise the scoped-release guard using authored, disposable Git histories."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

helper = Path(__file__).with_name("verify-firestore-release.py")


def git(root, *args):
    return subprocess.check_output(["git", "-c", "user.name=Release policy test", "-c", "user.email=release-test@example.invalid", *args], cwd=root, text=True).strip()


def write_manifest(root, name, version, identity=None):
    path = root / "packages" / name / "package.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"name": identity or "@dalgo/" + name, "version": version}))


for case in ["firestore_only", "other_version", "other_identity", "other_source", "pending_changeset", "removed_manifest", "minor_release", "unchanged", "invalid_source"]:
    with tempfile.TemporaryDirectory(prefix="firestore-release-policy-") as directory:
        root = Path(directory)
        git(root, "init", "--quiet")
        write_manifest(root, "firestore", "0.4.1")
        # An old/private identity is deliberately outside the selected release.
        write_manifest(root, "clickhouse", "0.1.0", "@dal-go/private-clickhouse")
        (root / ".changeset").mkdir()
        pending = root / ".changeset" / "deferred-clickhouse.md"
        pending.write_text('---\n"@dal-go/private-clickhouse": minor\n---\nDeferred.\n')
        git(root, "add", ".")
        git(root, "commit", "--quiet", "-m", "baseline")
        write_manifest(root, "firestore", "0.5.0" if case == "minor_release" else "0.4.1" if case == "unchanged" else "0.4.2")
        if case == "other_version": write_manifest(root, "clickhouse", "0.2.0", "@dal-go/private-clickhouse")
        if case == "other_identity": write_manifest(root, "clickhouse", "0.1.0", "@dalgo/dalgo2clickhouse")
        if case == "other_source": (root / "packages/clickhouse/new.ts").write_text("export {};\n")
        if case == "pending_changeset": pending.write_text("changed\n")
        if case == "removed_manifest": (root / "packages/clickhouse/package.json").unlink()
        git(root, "add", ".")
        git(root, "commit", "--allow-empty", "--quiet", "-m", "candidate")
        source = "invalid; source" if case == "invalid_source" else git(root, "rev-parse", "HEAD")
        result = subprocess.run([sys.executable, str(helper), source], cwd=root, capture_output=True, text=True)
        assert (result.returncode == 0) == (case == "firestore_only"), (case, result.stdout, result.stderr)
        if case == "firestore_only":
            receipt = json.loads(result.stdout)
            assert receipt == {"package": "@dalgo/firestore", "version": "0.4.2", "source": source}
        print("PASS scoped-release guard", case)
