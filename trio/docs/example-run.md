# Example run: a flashcard trainer

This is the first full end-to-end run of the workflow, from an empty folder to a merged pull request. It's here to show what each step produces and what each model actually contributed. Numbers are from that run. Yours will differ.

**The request:** *"A flashcard trainer: make decks (e.g. immunology terms), study cards that flip, and the app schedules hard cards more often (spaced repetition)."*

**Result:** a local Node.js web app (Express, built-in SQLite, plain HTML/CSS/JS). 46 tests, all passing; merged after two rounds of review.

## Step by step

| Step | What happened | Took |
|---|---|---|
| 0. Setup | `doctor.sh`: full mode, all three models signed in | 1 min |
| 1. Understand | Repo empty, so the Gemini scout was skipped (as the skill says). Claude recorded the environment and constraints. | 2 min |
| 2. Two plans | Claude and Gemini each wrote a full plan without seeing the other's. Gemini's was very detailed (exact scheduler math, database schema). | 3 min (Gemini) |
| 3. Merge | 18 recorded decisions: **11 from Gemini**, 3 from Claude, the rest shared. Gemini's better ideas included built-in SQLite over a JSON file (Claude checked it worked first), a scheduler that guarantees the four buttons never show the same interval, and a fix for a bug in Claude's plan (a deleted sample deck would have come back). | — |
| ⏸ Approval | The user approved the merged plan as written. | — |
| 4. Design | Claude wrote every screen, state and piece of text. Gemini's review raised 18 points, including **4 accessibility blockers** (a card that hid its text from screen readers; deck tiles keyboard users couldn't open). The same review fact-checked the 12 sample flashcards: **3 corrected** (NK cells, neoantigens, cytokine release syndrome). One review comment changed the contract: a Tab can't be typed into a text box, so the paste format had to change. | 4 min (Gemini) |
| 5. Build (parallel) | **Codex** built the backend from the contract: about 2,100 lines with its own tests, 21 min. **Gemini** wrote 24 acceptance tests from the contract alone, 6 min. **Claude** wrote the frontend. | ~25 min |
| 6. Integrate | Claude read Codex's diff, merged it, and ran everything: **44/44 passed on the first run**. Gemini's tests passed against code it had never seen. | — |
| 6. Visual QA | Claude's own check caught a broken finish screen. Gemini round 1 (12 screenshots) found 10 issues: lost page spacing, dark-mode contrast failures, small tap targets, and two gaps in the screenshot set. Round 2 (16 screenshots) confirmed 9 fixed and found 3 new ones, including a CSS rule that stopped elements from ever hiding. | 3 + 2 min (Gemini) |
| 7. PR | Private GitHub repo, a CI workflow running the tests, and a PR that says who wrote what. | — |
| 8. Review | **Codex round 1:** 14 findings. 11 fixed (including **deleted IDs being reused**, where a stale page could rate the wrong card, and a **DNS-rebinding hole** in the local API), 3 rejected with reasons. **Round 2:** 9 fixes verified and 2 more bugs fixed; Codex disputed the 3 rejections, so those went to the user. CI passed on Node 22.13 and 24. | ~10 min per round |
| ⏸ Merge | The user approved; the PR was merged; tests and a fresh start were checked on `main`. | — |

## What each model was best at

- **Gemini:** independent planning with precise specs; accessibility and copy review; fact-checking content; writing tests that only know the contract; spotting visual bugs in screenshots, including CSS that silently doesn't apply.
- **Codex:** fast, careful backend code that follows a contract to the letter and handles edge cases nobody specified. A strict reviewer that reproduces the bugs it reports.
- **Claude:** running the process, making the calls between competing suggestions, the frontend, integration, and keeping an honest record of what was and wasn't verified.

## Lessons that went back into the skill

- Codex's sandbox can't open network ports, so it can't run tests that start a server. Integration runs them.
- Screenshot QA needs touch emulation at phone sizes, and every shot must reload the page.
- Run visual QA twice: fixes regularly cause new layout regressions.
- Cap review at two rounds and hand remaining disagreements to the user.
- Fill each prompt right before sending it, so contract changes can't leave stale copies behind.
