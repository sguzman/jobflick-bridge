#!/usr/bin/env fish
# Explicit per-user native host registration for Firefox, not Chromium.
# This changes ~/.mozilla/native-messaging-hosts only when invoked with --install.
set -l host_name io.github.sguzman.jobflick
set -l manifest_dir "$HOME/.mozilla/native-messaging-hosts"
set -l manifest "$manifest_dir/$host_name.json"
set -l data_dir "$HOME/.local/share"
if set -q XDG_DATA_HOME
    set data_dir "$XDG_DATA_HOME"
end
set -l host_dir "$data_dir/jobflick-bridge"
set -l wrapper "$host_dir/native-host"

if test (count $argv) -ne 1
    echo "Usage: fish scripts/install-native-host.fish --install|--uninstall" >&2
    exit 2
end

switch $argv[1]
    case --install
        set -l binary (command -s jobflick)
        if test -z "$binary"
            echo "jobflick is not on PATH; no changes made" >&2
            exit 2
        end
        # A dangling symlink is not -e but must never be overwritten.
        # A symlinked host directory could redirect installed executables.
        if test -e "$manifest"; or test -L "$manifest"
            echo "Existing native host manifest: $manifest" >&2
            echo "Refusing to overwrite; inspect/remove it explicitly first" >&2
            exit 2
        end
        if test -L "$manifest_dir"; or test -L "$host_dir"
            echo "Native host directory is a symlink; refusing to install" >&2
            exit 2
        end
        if not command -sq jq
            echo "jq required; no changes made" >&2
            exit 2
        end
        mkdir -p -- "$host_dir" "$manifest_dir"; or exit 1
        chmod 700 -- "$host_dir"; or exit 1
        set -l staging (mktemp "$host_dir/native-host.XXXXXXXX"); or exit 1
        set -l escaped_binary (string escape --style=script -- "$binary")
        printf '#!/usr/bin/env fish\nexec %s native-host\n' "$escaped_binary" > "$staging"; or exit 1
        chmod 700 -- "$staging"; or exit 1
        mv -- "$staging" "$wrapper"; or exit 1
        # No string interpolation into JSON for an untrusted path. jq escapes it.
        jq -n --arg path "$wrapper" \
          '{name:"io.github.sguzman.jobflick", description:"Local Jobflick Firefox bridge", path:$path, type:"stdio", allowed_extensions:["jobflick-bridge@sguzman.github.io"]}' > "$manifest"; or exit 1
        chmod 600 -- "$manifest"; or exit 1
        echo "Registered native host for Firefox profiles: $manifest"
        echo "Note: this registration is per-user, not QA-profile isolated."
    case --uninstall
        if test -L "$manifest"
            echo "Refusing to follow/remove symlinked native host manifest" >&2
            exit 2
        end
        if test -f "$manifest"
            if not grep -q '"jobflick-bridge@sguzman.github.io"' "$manifest"
                echo "Manifest does not match this extension; refusing deletion" >&2
                exit 2
            end
            rm -- "$manifest"; or exit 1
            echo "Removed extension's Firefox native host manifest"
        end
        # Leave wrapper and Jobflick daemon/data untouched.
    case '*'
        echo "Usage: fish scripts/install-native-host.fish --install|--uninstall" >&2
        exit 2
end
