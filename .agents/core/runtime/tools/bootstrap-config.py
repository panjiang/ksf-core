"""Linux build bootstrap: read trusted JSON inputs before Node is available."""
import json
import re
import sys


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key: " + key)
        result[key] = value
    return result


try:
    with open(sys.argv[1], encoding="utf-8") as source:
        config = json.load(source, object_pairs_hook=unique)
    runtime = config["runtime"]
    package = runtime["packages"][sys.argv[2]]
    version, path, digest = runtime["version"], package["archive_path"], package["archive_sha256"]
    if type(config["schema_version"]) is not int or config["schema_version"] != 1:
        raise ValueError("unsupported build schema")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("invalid runtime version")
    expected = f".agents/core/runtime/packages/node-v{version}-{sys.argv[2]}.tar.gz"
    if path != expected or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("invalid runtime package")
    print(f"{version}|{path}|{digest}")
except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
    print("KSF build configuration: " + str(error), file=sys.stderr)
    sys.exit(1)
