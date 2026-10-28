#!/usr/bin/env python3
"""Read-only pre-merge Flyway collision/identity audit.

Usage (worktrees/checkouts, never operate on a deployed database):
 python3 services/api/scripts/check_flyway_compatibility.py \
   --source canonical=services/api/src/main/resources/db/migration \
   --source meeting=/tmp/pr1/services/api/src/main/resources/db/migration \
   --source media=/tmp/pr6/services/api/src/main/resources/db/migration \
   --source rooms=/tmp/pr5/services/api/src/main/resources/db/migration

Exit 0 only when no conflicting migration versions / obvious legacy identity
models exist. This is a preflight guard, not proof of DB-MIG-008 compatibility.
"""
import argparse
import hashlib
import re
import sys
from pathlib import Path

VERSION = re.compile(r"^V([0-9]+(?:\.[0-9]+)?)__.+\.sql$")
CREATE_TABLE = re.compile(r"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)", re.I)
LEGACY = re.compile(r"\b(user_accounts|organization_memberships|organizations)\b", re.I)


def scan(sources: list[tuple[str, Path]]) -> tuple[list[str], list[str]]:
    failures = []
    warnings = []
    versions = {}
    owners = {}
    schemas = {}
    for alias, directory in sources:
        if not directory.is_dir():
            failures.append(f"{alias}: migration directory not found: {directory}")
            continue
        for p in sorted(directory.glob("V*__*.sql")):
            match = VERSION.match(p.name)
            if not match:
                failures.append(f"{alias}: invalid Flyway filename {p.name}")
                continue
            body = p.read_bytes()
            version = match.group(1)
            identity = f"{alias}/{p.name}"
            sha = hashlib.sha256(body).hexdigest()[:12]
            if version in versions:
                original, digest = versions[version]
                failures.append(f"Flyway version V{version}: {original} versus {identity} "
                                f"({'same bytes' if digest == sha else 'different SQL'}); "
                                "two resources with one version cannot share a Core migration history")
            else:
                versions[version] = (identity, sha)
            sql = body.decode("utf-8-sig")
            schemas[identity] = sql
            for table in CREATE_TABLE.findall(sql):
                table = table.lower()
                owners.setdefault(table, []).append(identity)
    for table, scripts in sorted(owners.items()):
        if len(scripts) > 1:
            failures.append(f"Table '{table}' has multiple CREATE TABLE owners: {', '.join(scripts)}")
    # Existing room branch is based on obsolete SaaS tenant/identity structure.
    # Its identifiers must not be silently treated as canonical user IDs.
    if "users" in owners:
        for identity, sql in schemas.items():
            if LEGACY.search(sql):
                failures.append(f"{identity}: legacy user_accounts/organizations identity references "
                                "are incompatible with canonical users/organizational_units")
    if "meetings" in owners and "users" in owners:
        meeting_source = owners["meetings"][0]
        sql = schemas[meeting_source]
        if re.search(r"\borganizer_id\s+UUID\s+NOT\s+NULL\s*[,\n]", sql, re.I):
            warnings.append(f"{meeting_source}: organizer_id is a bare UUID; "
                            "require a validated FK to canonical users(id) in a forward migration")
        if "meeting_participants" in owners:
            warnings.append("Verify meeting_participants.user_id references canonical users(id), "
                            "and check all historical rows before validating a new FK.")
    if not versions:
        failures.append("No versioned migrations were found")
    return failures, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", action="append", required=True,
                        metavar="LABEL=PATH", help="A source migration directory")
    args = parser.parse_args()
    source_paths = []
    for item in args.source:
        if "=" not in item:
            parser.error(f"expected LABEL=PATH: {item}")
        label, location = item.split("=", 1)
        if not label or not location:
            parser.error(f"expected nonempty LABEL=PATH: {item}")
        source_paths.append((label, Path(location)))
    failures, warnings = scan(source_paths)
    for message in warnings:
        print("WARN: " + message)
    for message in failures:
        print("BLOCKER: " + message)
    print(f"Migration preflight: {len(failures)} blocker(s), {len(warnings)} warning(s).")
    if failures:
        print("Do not concatenate these migrations or edit applied Flyway checksums.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
