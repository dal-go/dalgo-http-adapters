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


for scope in ["firestore", "indexeddb"]:
    other_scope = "indexeddb" if scope == "firestore" else "firestore"
    for case in ["selected_only", "other_version", "other_identity", "other_source", "other_scoped_source", "renamed_other_scoped_source", "pending_changeset", "removed_manifest", "minor_release", "skipped_patch", "unchanged", "selected_identity", "prior_prerelease", "invalid_source", "invalid_scope"]:
        with tempfile.TemporaryDirectory(prefix=f"{scope}-release-policy-") as directory:
            root = Path(directory)
            git(root, "init", "--quiet")
            write_manifest(root, scope, "0.4.1-rc.0" if case == "prior_prerelease" else "0.4.1")
            write_manifest(root, other_scope, "0.4.1")
            if case == "renamed_other_scoped_source":
                git(root, "config", "diff.renames", "true")
                (root / "packages" / other_scope / "source.ts").write_text('export const value = "unselected package source";\n')
            # An old/private identity is deliberately outside the selected release.
            write_manifest(root, "clickhouse", "0.1.0", "@dal-go/private-clickhouse")
            (root / ".changeset").mkdir()
            pending = root / ".changeset" / "deferred-clickhouse.md"
            pending.write_text('---\n"@dal-go/private-clickhouse": minor\n---\nDeferred.\n')
            git(root, "add", ".")
            git(root, "commit", "--quiet", "-m", "baseline")
            version = {"minor_release": "0.5.0", "unchanged": "0.4.1", "skipped_patch": "0.4.3"}.get(case, "0.4.2")
            write_manifest(root, scope, version, "@dal-go/" + scope if case == "selected_identity" else None)
            (root / "packages" / scope / "fix.ts").write_text("export {};\n")
            if case == "other_version": write_manifest(root, "clickhouse", "0.2.0", "@dal-go/private-clickhouse")
            if case == "other_identity": write_manifest(root, "clickhouse", "0.1.0", "@dalgo/dalgo2clickhouse")
            if case == "other_source": (root / "packages/clickhouse/new.ts").write_text("export {};\n")
            if case == "other_scoped_source": (root / "packages" / other_scope / "new.ts").write_text("export {};\n")
            if case == "renamed_other_scoped_source":
                (root / "packages" / other_scope / "source.ts").rename(root / "packages" / scope / "moved.ts")
            if case == "pending_changeset": pending.write_text("changed\n")
            if case == "removed_manifest": (root / "packages/clickhouse/package.json").unlink()
            git(root, "add", ".")
            git(root, "commit", "--quiet", "-m", "candidate")
            source = "invalid; source" if case == "invalid_source" else git(root, "rev-parse", "HEAD")
            # Keep the original Firestore CLI default covered, too.
            arguments = [] if scope == "firestore" and case == "selected_only" else ["http" if case == "invalid_scope" else scope]
            result = subprocess.run([sys.executable, str(helper), source, *arguments], cwd=root, capture_output=True, text=True)
            assert (result.returncode == 0) == (case == "selected_only"), (scope, case, result.stdout, result.stderr)
            if case == "selected_only":
                receipt = json.loads(result.stdout)
                assert receipt == {"package": "@dalgo/" + scope, "version": "0.4.2", "source": source}
            print("PASS scoped-release guard", scope, case)
