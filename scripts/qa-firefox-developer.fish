#!/usr/bin/env fish
# Starts Firefox Developer Edition ONLY with an isolated, persistent QA profile.
# No native host installation, profile preference edits, or browser termination.
if not command -sq firefox-developer-edition
    echo "Firefox Developer Edition not found (expected: firefox-developer-edition)" >&2
    exit 2
end

set -l data_dir "$HOME/.local/share"
if set -q XDG_DATA_HOME
    # XDG_DATA_HOME is required to be an absolute path. An empty or
    # relative override could otherwise create a QA profile in an
    # unintended working directory or at the filesystem root.
    if test -z "$XDG_DATA_HOME"; or not string match -qr '^/' -- "$XDG_DATA_HOME"; or test "$XDG_DATA_HOME" = /
        echo "XDG_DATA_HOME must be a non-root absolute path; refusing to launch" >&2
        exit 2
    end
    set data_dir "$XDG_DATA_HOME"
end
set -l qa_root "$data_dir/jobflick-bridge-fde-qa"
set -l profile "$qa_root/profile"

# Refuse a symlink at either project-controlled boundary. Never follow a
# convenience link into the user's existing, personal Firefox profile.
if test -L "$qa_root"; or test -L "$profile"
    echo "QA profile path is a symbolic link. Refusing to launch." >&2
    exit 2
end
if test -e "$qa_root"; and not test -d "$qa_root"
    echo "QA profile root is not a directory: $qa_root" >&2
    exit 2
end

mkdir -p -- "$profile"; or exit 1
chmod 700 -- "$qa_root" "$profile"; or exit 1
set -l source_root (realpath -- (dirname (status filename))/..); or exit 1
set -l addon_path "$source_root/extension"
if not test -r "$addon_path/manifest.json"
    echo "Extension manifest missing: $addon_path/manifest.json" >&2
    exit 2
end

echo "Firefox Developer Edition QA profile: $profile"
echo "Extension manifest: $addon_path/manifest.json"
echo "No native host will be installed by this launcher."
echo "In about:debugging > This Firefox > Load Temporary Add-on, select the manifest."
echo "Temporary add-ons need reloading after a Firefox restart; signing is a later milestone."
exec firefox-developer-edition --no-remote --profile "$profile" "about:debugging#/runtime/this-firefox"
