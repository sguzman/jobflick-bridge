#!/usr/bin/env fish
# Deterministic unsigned Firefox add-on ZIP, independent of user Firefox.
# This script never signs, publishes, installs or changes browser prefs.
if test (count $argv) -ne 1
    echo "Usage: fish scripts/package-unsigned.fish OUTPUT.zip" >&2
    exit 2
end
set -l repo (realpath -- (dirname (status --current-filename))/..)
set -l output (realpath -m -- "$argv[1]")
if string match -q -- "$repo/extension/*" "$output"
    echo "Refusing to write generated archives inside extension source" >&2
    exit 2
end
if test -e "$output"; or test -L "$output"
    echo "Refusing to overwrite an existing unsigned archive: $output" >&2
    exit 2
end
for tool in zip find sort touch cp mktemp realpath
    if not command -sq $tool
        echo "Required packaging tool unavailable: $tool" >&2
        exit 2
    end
end
set -l work (mktemp -d); or exit 1
if not cp -a -- "$repo/extension/." "$work/"
    rm -rf -- "$work"
    exit 1
end
set -l links (find "$work" -type l -print)
if test (count $links) -gt 0
    echo "Refusing symlink content in Firefox release package" >&2
    rm -rf -- "$work"
    exit 2
end
# DOS minimum ZIP timestamp and stable locale guarantee identical metadata
# across different source checkout mtimes; no dependency install or secrets.
set -lx TZ UTC
set -lx LC_ALL C
if not find "$work" -type f -exec touch -t 198001010000 '{}' +
    rm -rf -- "$work"
    exit 1
end
set -l entries (cd "$work"; and find . -type f -printf '%P\n' | sort)
if test (count $entries) -eq 0
    echo "Extension sources are empty" >&2
    rm -rf -- "$work"
    exit 2
end
if not contains -- manifest.json $entries
    echo "Missing root extension manifest" >&2
    rm -rf -- "$work"
    exit 2
end
if not mkdir -p -- (dirname "$output")
    rm -rf -- "$work"
    exit 1
end
cd "$work"; or exit 1
# Stable entry order, no host extra fields, unchanged binary bytes. No
# compression avoids differences between zlib versions and is small here.
zip -q -X -0 "$output" $entries
set -l status $status
cd "$repo"
rm -rf -- "$work"
if test $status -ne 0
    exit $status
end
echo "Unsigned deterministic QA ZIP created: $output"
