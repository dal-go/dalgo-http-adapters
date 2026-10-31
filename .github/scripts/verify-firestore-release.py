"""Fail closed unless the merged source is an explicitly selected adapter-only patch release."""
import json
import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def entries(tree, directory):
    result = {}
    for row in git("ls-tree", "-r", tree, "--", directory).splitlines():
        metadata, path = row.split("\t", 1)
        result[path] = metadata.split()[2]
    return result


def verify(source, scope="firestore"):
    if scope not in {"firestore", "indexeddb"}:
        raise ValueError("Scoped releases support only firestore or indexeddb")
    if not re.fullmatch(r"[0-9a-f]{40}", source):
        raise ValueError("Expected the exact merged source SHA")
    previous = git("rev-parse", source + "^")
    before = entries(previous, "packages")
    after = entries(source, "packages")
    manifests = lambda values: {p: sha for p, sha in values.items() if p.count("/") == 2 and p.endswith("/package.json")}
    old_manifests, new_manifests = manifests(before), manifests(after)
    selected = f"packages/{scope}/package.json"
    if old_manifests.keys() != new_manifests.keys() or selected not in old_manifests:
        raise ValueError("Package inventory changed during a scoped release")
    for path in old_manifests:
        if path != selected and old_manifests[path] != new_manifests[path]:
            raise ValueError("Unselected package manifest changed: " + path)
    if entries(previous, ".changeset") != entries(source, ".changeset"):
        raise ValueError("Pending changesets must remain byte-identical")
    # Inspect both sides of a rename; destination-only output could hide a
    # deletion from an unselected package when a file moves into this scope.
    changed = git("diff", "--no-renames", "--name-only", previous, source, "--", "packages").splitlines()
    if any(not path.startswith(f"packages/{scope}/") for path in changed):
        raise ValueError("Unselected package source changed")
    old = json.loads(git("show", previous + ":" + selected))
    new = json.loads(git("show", source + ":" + selected))
    if old["name"] != "@dalgo/" + scope or new["name"] != old["name"]:
        raise ValueError("Unexpected scoped package identity")
    if not re.fullmatch(r"\d+\.\d+\.\d+", old["version"]):
        raise ValueError(f"Expected a stable prior {scope} version")
    major, minor, patch = map(int, old["version"].split("."))
    if new["version"] != f"{major}.{minor}.{patch + 1}":
        raise ValueError(f"Scoped releases must be exactly one {scope} patch")
    return {"package": new["name"], "version": new["version"], "source": source}


if __name__ == "__main__":
    print(json.dumps(verify(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "firestore")))
