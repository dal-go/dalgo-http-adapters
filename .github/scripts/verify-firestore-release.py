"""Fail closed unless the merged source is a Firestore-only patch release."""
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


def verify(source):
    if not re.fullmatch(r"[0-9a-f]{40}", source):
        raise ValueError("Expected the exact merged source SHA")
    previous = git("rev-parse", source + "^")
    before = entries(previous, "packages")
    after = entries(source, "packages")
    manifests = lambda values: {p: sha for p, sha in values.items() if p.count("/") == 2 and p.endswith("/package.json")}
    old_manifests, new_manifests = manifests(before), manifests(after)
    selected = "packages/firestore/package.json"
    if old_manifests.keys() != new_manifests.keys() or selected not in old_manifests:
        raise ValueError("Package inventory changed during a scoped release")
    for path in old_manifests:
        if path != selected and old_manifests[path] != new_manifests[path]:
            raise ValueError("Unselected package manifest changed: " + path)
    if entries(previous, ".changeset") != entries(source, ".changeset"):
        raise ValueError("Pending changesets must remain byte-identical")
    changed = git("diff", "--name-only", previous, source, "--", "packages").splitlines()
    if any(not path.startswith("packages/firestore/") for path in changed):
        raise ValueError("Unselected package source changed")
    old = json.loads(git("show", previous + ":" + selected))
    new = json.loads(git("show", source + ":" + selected))
    if old["name"] != "@dalgo/firestore" or new["name"] != old["name"]:
        raise ValueError("Unexpected scoped package identity")
    if not re.fullmatch(r"\d+\.\d+\.\d+", old["version"]):
        raise ValueError("Expected a stable prior Firestore version")
    major, minor, patch = map(int, old["version"].split("."))
    if new["version"] != f"{major}.{minor}.{patch + 1}":
        raise ValueError("Scoped releases must be exactly one Firestore patch")
    return {"package": new["name"], "version": new["version"], "source": source}


if __name__ == "__main__":
    print(json.dumps(verify(sys.argv[1])))
