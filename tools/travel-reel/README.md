# Travel Reel

Turns "where I went for the last 100 days" into a cinematic satellite-globe video: title card, the route drawing itself stop by stop, a day counter, distance, travel mode, and a closing summary card. It needs no API key. Imagery comes from Esri World Imagery and the globe is rendered with MapLibre.

## 1. Get your route

**Option A: from Google Maps Timeline (recommended)**

1. On your phone: Settings → Location → Location services → Timeline → **Export Timeline data**. You get `Timeline.json`.
   (If you have an older Google Takeout export, point `--in` at its `Semantic Location History` folder instead.)
2. Convert it:

```sh
node tools/travel-reel/from-timeline.mjs --in Timeline.json --days 100 --geocode --out my-trip.json
```

3. Open `my-trip.json` and fix any names or modes you don't like. This file is the whole script of the video.

**Option B: write it by hand.** Copy `trip.sample.json` and list your stops in order:

```json
{ "name": "Manali", "region": "Himachal", "lat": 32.2432, "lon": 77.1892, "arrive": "2026-07-01", "mode": "road" }
```

`mode` is how you *arrived* at that stop: `flight`, `road`, `train`, `boat` or `walk`. If you leave it out, legs over 700 km count as flights.

## 2. Render

```sh
node tools/travel-reel/render.mjs --trip my-trip.json --preview                 # quick low-fps draft
node tools/travel-reel/render.mjs --trip my-trip.json                           # 1920x1080 MP4
node tools/travel-reel/render.mjs --trip my-trip.json --vertical --out output/reel-9x16.mp4   # Reels / Shorts / TikTok
```

The video lands in `output/`. Tiles are cached in `output/.tile-cache`, so the second render of the same trip is much faster.

| Option | Default | Description |
|--------|---------|-------------|
| `--trip` | `trip.sample.json` | Trip JSON |
| `--out` | `output/travel-reel.mp4` | Output file |
| `--fps` | 30 | Frame rate |
| `--width` / `--height` | 1920 / 1080 | Frame size |
| `--vertical` | | 1080x1920 |
| `--preview` | | 8 fps, 960x540 draft |
| `--from` / `--to` | | Render a time window (seconds) |
| `--ffmpeg` | `$FFMPEG` or `ffmpeg` | ffmpeg binary |

Requirements: Node 22, Playwright with Chromium, and ffmpeg. With no system ffmpeg, `pip install imageio-ffmpeg` bundles one; point `FFMPEG` at `python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"`.

The video has no audio. Add music in any editor (CapCut, iMovie). Imagery © Esri, Maxar, Earthstar Geographics. Keep that credit in the post caption if you publish.
