# Celeste

A cinematic, autopiloted orbital-mechanics toy set in a compressed solar system.
Pick a planet and the ship flies itself there with real (n-body) gravity:
departure burn, mid-course corrections, capture into orbit. You watch.

It is named after the orbital-mechanics game in Vernor Vinge's *The Peace War*.

## What you see

- **Blue line**: the ship's actual future path through space, one continuous line
  (it snakes around planets because they move while the ship orbits them).
- **Purple line**: the orbit the ship is in right now, around the planet whose
  gravity well it is in, otherwise around the Sun.
- **Green arcs**: upcoming burns. They turn from grey to green as the burn nears.
- A cinematic camera that frames each phase (parked, departure, cruise, arrival)
  and a time director that speeds through coasts but plays every burn in slow
  motion. No wait before a burn is longer than about 30 seconds.

## Transfer types

After picking a planet, choose how to get there. Each button shows the fuel
that transfer would use (measured by flying it headlessly in the background,
not from a formula); the panel shows fuel used live as the trip happens.
Fuel is total thrust delivered (delta-v), shown as a plain number.

| Type | What it does |
| --- | --- |
| Hohmann | The textbook cheapest two-burn transfer: half an ellipse touching both orbits, launched only when the planets line up (may mean waiting). |
| Go now | Leave immediately, whatever the alignment: the planner finds a path that meets the target where it will be (Lambert-style shooting). |
| Bi-elliptic | Overshoot to a far point well beyond both orbits, burn there, then fall to the target. Long, and cheaper than Hohmann only for very different orbit sizes. |
| Slingshot | Swing past another planet first and borrow its orbital speed (a real gravity assist, since the physics is full n-body). |
| Torch | Thrust the whole way with closed-loop guidance, routing around the Sun, then spiral down into orbit. Fast and very expensive. |

## Controls

| Input | Action |
| --- | --- |
| Planet buttons (top left) | Fly there. Click again to cancel. |
| `,` / `.` or the ‹ › buttons | Nudge the cruise speed (¼× to 4× of automatic) |
| Drag, scroll, pinch, `+` / `−` | Pan and zoom (switches the camera to manual) |
| Camera button or `C` | Back to the cinematic camera |
| `G` or the ghost button | Ghost planets: where planets will be when you arrive |
| `D` | Hidden debug panel: sliders for how far out the cinematic camera frames a transfer, and for the Brachistochrone torch thrust (1–40, default 5: more is faster and costs more fuel). Saved in your browser |

## How it works

- **Physics** (`src/nbody.js`): the ship feels the gravity of the Sun and every
  planet at once (restricted n-body; the planets ride fixed circular orbits).
  RK4 with a step proportional to the local dynamical time. The coasting
  trajectory is cached, and the ship follows exactly the path that is drawn.
- **Scale** (`src/system.js`): real orbit-radius ratios, one Earth year = 600 s of
  game time, planets enlarged and made heavier so arrivals are playable.
- **Prediction** (`src/predict.js`): extends the cached path many laps ahead,
  finds encounters, and decides whether an orbit "holds" (captured) by checking
  that it survives three more laps.
- **Planning** (`src/planner.js`, run in a Web Worker): departure burns for each
  transfer type (textbook estimate refined by shooting with the real
  integrator), far-point and flyby-aiming burns, mid-course corrections,
  capture and rescue burns.
- **Autopilot** (`src/autopilot.js`): flies a whole trip (burns ignite and cut
  exactly on schedule; torch guidance), shared by the live game and the
  headless dry runs that produce the fuel estimates.
- **Rendering**: [three.js](https://threejs.org) with custom shaders for the Sun,
  planets, Saturn's rings, antialiased glow lines and bloom. No build step:
  plain ES modules and a vendored copy of three.js.

## Run locally

Any static file server works. From the repository root:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. (Opening `index.html` directly from disk
does not work, because ES modules and Web Workers need HTTP.)

## Deploy

Celeste is a static site, so you can host it anywhere that serves files:
nginx, Apache, Caddy, GitHub Pages, Netlify, an S3 bucket and so on.

1. Copy the site files to your web server's document root:

   ```sh
   deploy/deploy.sh /var/www/celeste
   ```

   This copies `index.html`, `style.css`, `src/` and `vendor/`, and stamps the
   build time into the debug logger. Copying those four items by hand works too.

2. Point a site at that directory. `deploy/nginx.example.conf` is a complete
   nginx example. Replace `example.com` and the paths, then:

   ```sh
   sudo cp deploy/nginx.example.conf /etc/nginx/sites-available/celeste
   sudo ln -s /etc/nginx/sites-available/celeste /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

   Serve it over HTTPS in production (e.g. with certbot).

### Optional: remote debug logs

The game sends console output, errors, anomalies (such as non-finite ship
state, slow frames or sharp corners in the drawn path), periodic state
snapshots and freeze reports to `POST /api/log`. A watchdog Web Worker reports
freezes even when the page's main thread is stuck. In the browser console,
`celesteDebug.report('note')` sends a report immediately.

This is optional. Without a receiver the POSTs fail quietly and the game is
unaffected. To collect logs:

```sh
python3 tools/log-server.py --port 8790 --file /var/log/celeste-debug.jsonl
```

Then enable the `/api/log` location in the nginx example (and its
`limit_req_zone`, which belongs in the `http` context). Each report is stored
as one JSON line. The receiver is write-only and never serves logs back. Run it
under systemd or similar to keep it alive.

Note that the logs include the visitor's IP address and browser user agent.

## Credits

- Earth texture: NASA Earth Observatory / NASA Goddard Space Flight Center,
  "Blue Marble" land and oceans mosaic (public domain), via Wikimedia Commons.
- Mercury texture: NASA MESSENGER global mosaic, 2013 (public domain).
- Mars texture: NASA/JPL/USGS Viking MDIM 2.1 colorized mosaic (public domain).
- Jupiter texture: NASA/JPL/Space Science Institute, Cassini cylindrical map
  PIA07782 (public domain). All via Wikimedia Commons.
- Saturn texture: "Saturn map" by Askaniy Anpilogov and Björn Jónsson, from
  Voyager and Cassini imagery, CC BY-SA 3.0, via Wikimedia Commons
  (textures/saturn.jpg is a resized copy under the same licence).
- Venus is procedural (NASA's Venus maps show the radar surface under the
  clouds, not what an observer would see).
- Planet spin axes: IAU Working Group on Cartographic Coordinates and
  Rotational Elements (north pole right ascension / declination).
- Rendering: three.js (MIT).

## Project layout

```
index.html, style.css     page, HUD
src/main.js               game loop, autopilot, time director, cinematic camera, HUD
src/nbody.js              n-body integrator, trajectory cache, ship simulation
src/predict.js            path prediction, encounters, orbit fate
src/autopilot.js          trip flying, torch guidance, fuel, headless dry runs
src/planner.js            departure / aim / correction / capture planning
src/planner-worker.js     runs planning off the main thread
src/physics.js            two-body (Kepler) helpers
src/system.js             the Sun and planets
src/visuals.js            shaders: stars, Sun, planets, rings, ship, particles
src/ribbon.js             antialiased glow lines
src/debug.js              remote debug logging
src/watchdog-worker.js    freeze watchdog
vendor/three/             three.js r170 (MIT, see vendor/three/LICENSE)
textures/                 planet maps from NASA mission imagery (see Credits for licences)
deploy/                   deploy script and nginx example
tools/log-server.py       optional debug-log receiver
```
