# Testing guide

Test in four stages, from free to real:

| Stage | Needs | Costs |
|---|---|---|
| 1. Install and run the automated tests | Windows PC, Node.js 20+ | Free |
| 2. Dashboard with the simulator, no AI | Stage 1 | Free |
| 3. Claude with the simulator | Claude API key with credit | About $0.50–1.50 |
| 4. The real game | LMU + the shared memory plugin | Depends on how long you drive |

Do them in order. Each stage rules out a class of problems before the next one.

---

## Stage 1: install and run the automated tests

1. Install Node.js 20 LTS (or newer) from [nodejs.org](https://nodejs.org/). Open
   a **new** PowerShell window afterwards and check:

   ```powershell
   node -v    # should print v20.x or higher
   ```

2. Get the code (README step 2.1) and go to the project folder:

   ```powershell
   git clone https://github.com/dustysi221/dustysi221.git
   cd dustysi221
   git checkout claude/kind-shannon-g0iy1c
   cd lmu-telemetry-dashboard
   ```

3. Install and test:

   ```powershell
   npm install
   npm test
   ```

**Pass:** the last lines say `# pass 24` and `# fail 0`.

These tests check the data decoding, the tire and strategy maths, and that the
server streams data. They don't need the game or an API key.

---

## Stage 2: the dashboard with the simulator (no AI, free)

1. Make sure there is **no** `.env` file yet, or that `CLAUDE_API_KEY` in it is
   empty. This guarantees nothing is charged.
2. Start the simulator:

   ```powershell
   npm run mock
   ```

   The window should show `Telemetry source: mock` and
   `Claude analysis disabled: set CLAUDE_API_KEY in .env to enable it`.
3. Open **http://localhost:3000** in Chrome or Edge.

**Check:**

- [ ] The top-right pill is green and says **Live · simulator**; the other pill says **AI off**.
- [ ] Speed, gear and RPM change several times a second.
- [ ] The four tires show temperatures, pressure in psi and wear, and the colors change as temperatures move.
- [ ] Current lap time counts up; after ~100 s a **Last** lap time appears.
- [ ] After two laps, **Per lap** fuel shows about 2.9 L.
- [ ] ⚙ settings: switching psi → kPa and km/h → mph changes the numbers.
- [ ] Press **Ctrl+C** in PowerShell: the page shows **Server offline · retrying**. Run `npm run mock` again: it reconnects by itself.

To see more in less time, create a `.env` file containing `MOCK_SPEED=10`, and
restart. Laps then take 10 seconds.

---

## Stage 3: Claude with the simulator (costs a little)

Now test the AI with settings that keep the cost low.

1. Create `.env` from the template and edit it:

   ```powershell
   copy .env.example .env
   notepad .env
   ```

   Set these lines:

   ```ini
   CLAUDE_API_KEY=sk-ant-...your key...
   ANALYSIS_MODEL=claude-sonnet-5
   ANALYSIS_INTERVAL_MS=60000
   MOCK_SPEED=5
   ```

   - `ANALYSIS_MODEL=claude-sonnet-5` makes each call roughly half the price of the default.
   - `ANALYSIS_INTERVAL_MS=60000` runs the tire engineer only once a minute, so you mostly trigger it yourself with **Analyze now**.
   - `MOCK_SPEED=5` makes laps take 20 s, so strategy calls come every 20 s.

2. Start `npm run mock`. The window should now say
   `Claude tire analysis: claude-sonnet-5 ...`. Open http://localhost:3000.

**Check:**

- [ ] The AI pill says **AI sonnet-5**.
- [ ] Within about a minute (the first scheduled run), or right away if you click **Analyze now**, the **Tire engineer** column fills in: a health badge (GOOD / FAIR / CRITICAL), a summary, pressure change, pit window and driving tips. The same message appears in **Engineer radio**.
- [ ] Click **Analyze now** again: a new tire message arrives within ~5–10 s.
- [ ] After about 40 s (the first clean lap at this speed), the **Strategist** column fills in: the call, confidence, fuel, tires, plan and rivals.
- [ ] The fuel figure mentions about **2.9 L/lap**, and the call plans a stop around **lap 29–30**. The simulated car needs exactly one fuel stop, and its tires last to the finish.
- [ ] The rivals line mentions the simulated cars (#6 Porsche, #8 Toyota, #50 Ferrari).
- [ ] The **Engineer radio** header shows the number of calls and cost so far.
- [ ] Open http://localhost:3000/api/tire-analysis and http://localhost:3000/api/strategy: both show JSON with the fields from the README.

**Optional: test a pit stop.** Set `MOCK_SPEED=20`, restart, and wait about
2.5 minutes. The simulated car stops at the end of lap 30. Afterwards, fuel jumps
back to ~90 L, tire wear resets to ~0%, and the strategist posts a new call.
This costs roughly another $0.50–1.

**When you're done,** stop the server (Ctrl+C) and check the real charge on the
[Console usage page](https://console.anthropic.com/). It usually appears within
a few minutes. Compare it with the cost shown on the dashboard.

**If a check fails:** the dashboard puts errors in the **Engineer radio** feed
(e.g. "Invalid Claude API key", "rate limit"). The PowerShell window shows the
same message. README section 6 covers each one.

---

## Stage 4: the real game

1. Install and enable the plugin (README steps 2.4 and 2.5).
2. In `.env`, remove the `MOCK_SPEED` line. For a first live test, keep
   `ANALYSIS_INTERVAL_MS=60000` so you can focus on the data without
   spending much.
3. Start the server with the real source:

   ```powershell
   node server.js
   ```

   The window should say `Telemetry source: rf2`. The dashboard should say
   **Waiting for LMU**.
4. Start LMU and a **practice** session, preferably on a track you know. Drive
   out of the garage.

### 4a. Is the data arriving?

- [ ] The pill turns green and says **Live**.
- [ ] Speed, gear and RPM match the in-game dash.

If it stays on **Waiting for LMU**, the plugin isn't loaded. See README
section 6.

### 4b. Is the data correct?

This is the most important check. Open **http://localhost:3000/api/snapshot**
while driving and refresh it a few times.

| Value | What it should look like |
|---|---|
| `tires.*.temps` | Near the air/track temperature on cold tires; roughly 60–110 °C once warm |
| `tires.*.pressureKpa` | Roughly 150–220 |
| `tires.*.wearPercent` | 0–2 on new tires, slowly rising |
| `vehicle.fuelL` | Matches the fuel shown in the game |
| `vehicle.speedKph` | Matches the in-game speed |
| `vehicle.name`, `session.trackName` | Your car and track, readable text |

Values like −273, 0 everywhere, huge numbers or garbled names mean the plugin's
data layout doesn't match what the server expects. Stop there and send the
details (see "What to send me" below).

### 4c. Are the tires the right way round?

- [ ] **Corners:** in a long right-hand corner, the **left** tires (FL, RL) should heat up more. In a long left-hand corner, the right ones should.
- [ ] **Pressure:** compare the dashboard's psi with the in-game tire pressure display after a few laps. They should be close.
- [ ] **Inside vs outside:** with a normal setup (negative camber), the **I** (inner) edge usually runs a few degrees hotter than **O** (outer) on every tire.

### 4d. Does fuel and strategy make sense?

Drive 3–4 clean laps.

- [ ] **Per lap** fuel on the dashboard matches your in-game fuel use per lap.
- [ ] The strategist's fuel status agrees with it, and its "last lap to pit" is plausible for your tank.
- [ ] In a race against AI, the rivals line names real cars around you in your class, with believable gaps.

### 4e. Pit stop and pause

- [ ] Pause the game: the dashboard dims and says **Paused**. Resume: it goes back to **Live**.
- [ ] Make a pit stop with fuel and new tires: fuel goes up, wear drops to ~0%, and the strategist posts a new call after your next clean lap.

### 4f. Cost

After the session, compare the dashboard's cost with the Console usage page.
Then pick your everyday settings from README section 5, for example Sonnet 5
at 5 s, or Opus 5 at 15 s.

---

## What to send me if something is wrong

1. The text in the PowerShell window (copy everything since the start).
2. The contents of http://localhost:3000/api/snapshot while you're on track.
3. A screenshot of the dashboard.
4. The plugin version, if you know it, and which LMU session type you were in.

Don't send your `.env` file: it contains your API key.
