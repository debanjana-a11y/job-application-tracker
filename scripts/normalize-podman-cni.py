#!/usr/bin/env python3
import json
import os
import stat
import sys
import tempfile
from pathlib import Path


def main():
    if len(sys.argv) != 2:
        print(f"Usage: {Path(sys.argv[0]).name} CNI_CONFIG", file=sys.stderr)
        return 2

    config_path = Path(sys.argv[1])
    if not config_path.exists():
        print(f"No CNI config at {config_path}; skipping CNI compatibility adjustment.")
        return 0

    try:
        config = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        print(f"Cannot read CNI config {config_path}: {error}", file=sys.stderr)
        return 1

    version = config.get("cniVersion")
    if version == "0.4.0":
        print(f"{config_path} already uses CNI version 0.4.0.")
        return 0
    if version != "1.0.0":
        print(f"Unsupported CNI version {version!r} in {config_path}; leaving it unchanged.", file=sys.stderr)
        return 1

    config_path.with_suffix(config_path.suffix + ".bak").write_text(
        config_path.read_text()
    )
    mode = stat.S_IMODE(config_path.stat().st_mode)
    file_descriptor, temporary_path = tempfile.mkstemp(
        prefix=f".{config_path.name}.",
        dir=config_path.parent,
        text=True,
    )
    try:
        with os.fdopen(file_descriptor, "w") as temporary_file:
            config["cniVersion"] = "0.4.0"
            json.dump(config, temporary_file, indent=2)
            temporary_file.write("\n")
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, config_path)
    except OSError:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise

    print(f"Adjusted {config_path} from CNI 1.0.0 to 0.4.0 for the installed Podman plugins.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OSError as error:
        print(f"Failed to update CNI config: {error}", file=sys.stderr)
        raise SystemExit(1)
