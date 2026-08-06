---
name: bku-check
description: >-
  The folder BigKiji shares with the owner's iPhone (iCloud Drive /
  BigkijiUniverse-Check). Read this before saving any finished work, before
  answering "look at what I sent you", and before telling the owner they can open
  something on their phone. Covers the fixed rule that finished games, videos and
  demos are saved there in a form the phone can actually run, why an HTML file on
  its own does not satisfy that, and how iCloud placeholders hide what the owner
  sent. Triggers: BKU-Check, check folder, iPhone, 携帯, スクショ, 完成品, デモ,
  納品, input フォルダ, deliverables, iCloud.
---

# BKU-Check — the owner's phone is the other end of this folder

`~/Library/Mobile Documents/com~apple~CloudDocs/BigkijiUniverse-Check`, resolved as
`checkRoot` by `src/core/path-config.js`. Three drawers, three different jobs.

## input/ — a pile, on purpose

The owner drops things in from the phone: screenshots to look at, links to YouTube or
SNS posts they want used as a reference, notes. **Links and text go in as `.txt`,
screenshots stay images, video stays video.**

**Nothing here is processed automatically.** No watcher, no launchd job, no unattended
model. The owner asks for it to be read when they want it read. Paying an LLM to sit and
watch a folder is exactly what the owner does not want.

When they say "見て" / "look at what I sent":

```
bigkiji check          # downloads the iCloud placeholders, then lists what is there
```

### Why that command exists instead of `ls`

This Mac has **"Optimize Mac Storage" on**. A file the phone uploads does not arrive as
a file — it arrives as a zero-byte stub named `.holiday.jpg.icloud`, and the bytes stay
in iCloud until something asks for them. `readdir` on `input/` will happily report an
empty folder while the owner is looking at five screenshots they just sent.
`src/core/check-folder.js` calls `brctl download` and waits for the stub to disappear.
A file that never arrives is reported as still pending — **never** presented as an empty
one.

## deliverables/ — finished work, saved so the phone can run it

**This is a standing rule from the owner, not a preference.** When a game, a video, or a
demo is finished, it is saved to `deliverables/<date>-<name>/` **in a state the iPhone
can actually use**. Three things, and the work is not "saved" until all three are there:

| | |
|---|---|
| `play.md` + a QR image | How to actually run it. The private URL served from this Mac, plus the one-line command to start the server |
| `preview.mp4` | H.264 + AAC, `+faststart`, small. **This is what makes the deliverable checkable when the Mac is asleep.** Quick Look plays video fine |
| the source | Self-contained HTML and assets, for the archive |

### The trap: an HTML file on its own is not "playable on the phone"

**iOS Quick Look has JavaScript disabled** — Apple turned it off in iOS 13 because
previewing a local file could ping a remote server and track the user. Tapping a `.html`
in the Files app renders the CSS and runs **none** of the game. Top-level `data:` URLs
are blocked in Safari too.

So: never write "open this on your phone and play it" about a bare HTML file. Say what
is true — the source is archived, the video shows it running, and `play.md` has the URL
that actually works.

### Nothing is published

The owner's instruction is **外には一切出さない** — nothing goes public. No Vercel, no
tunnels to the open internet, no sharing links. Running it on the phone means serving it
from this Mac over Tailscale (the owner's own devices, a private mesh) or the local
Wi-Fi. `src/core/tailscale-remote-access.js` already does this and generates the QR;
`src/core/preview-server.js` already serves `/preview/<project>/`.

### Video

Anything generated (LTX-2, Wan2.2, ComfyUI) may be in a codec the iPhone will not play.
Always put an H.264 + AAC copy in `deliverables/`, keep the original master on the Mac —
iCloud storage is finite and the phone only needs to check the result:

```
ffmpeg -i master.mov -c:v libx264 -pix_fmt yuv420p -crf 24 -preset medium \
       -c:a aac -b:a 128k -movflags +faststart preview.mp4
```

`+faststart` matters: without it the index sits at the end of the file and the phone
buffers the whole thing before showing a frame.

## reports/ — what was checked

Dated folders. Markdown **and** PDF, because Quick Look renders a PDF's tables and
headings properly while `.md` shows as plain text. Anything meant to be read on the
phone gets `.txt`, `.md`, `.pdf` or `.json` — a `.diff` will not open.

Put **links the owner can tap** in the report (GitHub run URLs, PR URLs). The point of a
report on a phone is that the owner can verify the claim, not just read it.

## Working rules

- **Copy, never move.** The source of truth stays in git and on the Mac. This folder is
  the phone's window, not the filing cabinet. Moving code out of the repo breaks the app.
- **Do not sync the heavy things**: `.bigkiji/` (27GB of leftover worktrees),
  `node_modules/`, `dist/`.
- **Do the cheap work locally.** Copying, `brctl`, `ffmpeg`, `git diff`, `gh api`
  formatting and PDF generation are shell work with no model involved. Summarising and
  translating go to `~/.claude/bin/ai-local` (free, local). Only design, code and
  fact-checking are worth a paid model. Local model output is drafted, then its numbers,
  SHAs and filenames are checked against the source before it ships.
- **Ollama calls go through the GPU signal** (`gpu-signal.sh run`) — ComfyUI, LTX-2 and
  ACE-Step share this machine's memory, and two at once means an OOM.
- **iCloud upload is background work.** Never tell the owner "it has synced". Say what
  was written locally and let them confirm on the phone.
