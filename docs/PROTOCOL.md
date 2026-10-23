# 🔌 Jobflick native protocol

Authoritative source: https://github.com/sguzman/jobflick/blob/main/docs/BROWSER-BRIDGE.md

The installed `jobflick native-host` is launched by Firefox Native Messaging: one little-endian 32-bit length-prefixed UTF-8 JSON request, one response. The Execarium document is capped at 256 KiB; additionally bound extension message size. No HTTP socket.

| Action | Input | Meaning |
| --- | --- | --- |
| `validate_spec` | `spec_yaml` | Real consumer validation, **no execution** |
| `submit_spec` | `spec_yaml`, optional `origin_tab_id` | Only after Run click; durable queue and reply |
| `inspect` | `id` | Read job state and metadata |
| `show` | `id` | Read finished report |
| `cancel` | `id` | Explicit cancellation |

Submission response includes `ok`, `job.id`, optional `job.name` and `job.color`. Terminal states are `succeeded`, `failed`, `cancelled`, `timed_out` and `interrupted`. The optional browser origin token is not part of YAML. Do not introduce a second validation engine in the extension.

On ambiguous submission failure, inspect the Jobflick inbox before any new attempt. Sending a job twice may cause actual duplicate side effects.
