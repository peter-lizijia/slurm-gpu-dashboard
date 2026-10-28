#!/usr/bin/env python3
"""Check publishable files for common credential and private-artifact mistakes."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
EXCLUDE = {".git", "node_modules", "dist", "runtime", "logs", "__pycache__", "test-results", "playwright-report"}
PATTERNS = {
    "JWT credential": r"eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}",
    "Supabase key": r"sb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}",
    "GitHub credential": r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})",
    "private key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "personal absolute path": r"/(?:Users|home)/[a-z][a-z0-9._-]+/",
    "embedded database password": r"postgres(?:ql)?://[^\s:@]+:[^\s@]+@",
}


def problems(path: str, content: str) -> list[str]:
    name = Path(path).name
    errors = []
    if name.startswith(".env") and name not in {".env.example", ".env.server.example"}:
        errors.append("environment file")
    if name.endswith((".pem", ".key", ".log")) or "snapshot" in name.lower():
        errors.append("private runtime artifact")
    for label, pattern in PATTERNS.items():
        if re.search(pattern, content):
            errors.append(label)
    return errors


def main() -> int:
    if (ROOT / ".git").exists():
        result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                                cwd=ROOT, capture_output=True, check=True)
        files = [ROOT / name for name in result.stdout.decode().split("\0") if name]
    else:
        files = [p for p in ROOT.rglob("*") if not EXCLUDE.intersection(p.relative_to(ROOT).parts)]
    failures = []
    for path in files:
        if not path.is_file():
            continue
        relative = str(path.relative_to(ROOT))
        if path.is_symlink():
            failures.append((relative, ["symlink requires manual review"]))
            continue
        content = path.read_bytes().decode("utf-8", errors="replace")
        found = problems(relative, content)
        if found:
            failures.append((relative, found))
    for path, labels in failures:
        # Never print credential contents into CI logs.
        print(f"{path}: {', '.join(labels)}", file=sys.stderr)
    if failures:
        return 1
    print("Public-file checks passed. Review data, screenshots and Git history separately.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
