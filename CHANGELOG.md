# Changelog

All notable changes to cc-accounts are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.17.1 (2026-11-18)

- A session prunes its own transcript after it compacts on managed and Team accounts too. The plugin learned of a compaction from its `session.compact` hook, and Claude Code's built-in `sec-default` plugin, seated for those accounts, sends that event past every plugin a person installed ("its session.compact hook was skipped"). So a long-running session kept everything from before its last compaction until some session next started: on 2026-11-18 a transcript two compactions old held 5.8 MB of such rows out of 19.5 MB. The plugin no longer hooks the event. At every main turn's end it runs `prune.py --session <id> --since prune-tails.json`, which reads only the rows written since its last look and prunes when a compact boundary is among them, or when the file was replaced or cut since. One look runs at a time per session.

## 0.17.0 (2026-11-18)

- A move keeps the session's model and effort. The new process started on Claude Code's configured model and effort, so a model picked with `/model` and an effort set with `/effort` for the session alone were lost at every move. In VS Code the panel's own model pick, which cca-stream replayed, could be older than the model the session ran on (2026-11-14: a session on Fable 5.2 came back on Opus 5.5). The plugin now writes the session's model and the effort of its last request beside the switch request, and cca and cca-stream start the new process with them in place of the first run's `--model` and `--effort`.
- cca-stream replays the settings the VS Code panel set for the session alone (`apply_flag_settings`, such as focus view or a session-only effort), which a move used to drop.

## 0.16.0 (2026-11-18)

- A move the balancer queued behind background work is decided again at each turn end. It used to wait for as long as the work ran and then go regardless, though the readings that called for it had changed: on 2026-11-17 a session queued to spend cto's week before its reset would still have moved after the reset. Now the move keeps waiting while it is still called for, goes to another account if that one fits better, and is dropped when nothing calls for it, with the conversation recorded back on its account. The session counts on the account it runs on while it decides, not on the target already recorded for it. A switch a person asked for with `/account` is never changed this way.
- Remote Control keeps working after a move in VS Code. A bridge belongs to the account of the process that opened it, and the new process ran none while the panel still showed Remote Control as connected, so the session could not be reached from claude.ai or the phone. cca-stream now turns Remote Control on in the new process, on the account it moved to, and passes the new bridge's state to the panel under the epoch the panel knows. A process that cannot turn it on makes the panel show it off. The panel's link still points at the old session until Remote Control is turned off and on there or the tab is reopened; the new session is in claude.ai's list for the new account.

## 0.15.0 (2026-11-16)

- A move in VS Code keeps the tab connected. 0.14.0 ended the tab's process after a move so the panel would start the conversation again and show the new account, but the panel shows a conversation whose process ended as stopped until the next message: sessions looked idle or disconnected right after finishing a turn. A move that had work to carry on ended its process at the first turn end with no background work, which could come hours later on the account the session had worked on since (2026-11-16: moved at 01:50, ended at 07:09). Every move now reopens the conversation in place and the process runs on. The status line names the account; the panel's header shows the account the tab was opened on until the tab is reopened, since the extension reads it only from the process it started. `CCA_REFRESH` is gone, and the Stop hook no longer counts scheduled wakeups.
- A desktop session counts on the account the app signed it in to when `~/.claude`'s login record names the app's login too. Claude Code writes the login it runs on into its config dir's record, so desktop sessions leave the app's login in `~/.claude.json`, and the account kept in `~/.claude` then matched the app's login as well; the first in the table won. Desktop sessions saved the app account's readings under that account, whose week was full, so the balancer kept moving VS Code sessions onto it and straight back (one conversation moved eight times in 70 minutes on 2026-11-15). A session's own login record now names its account only when no other account holds the same login.

## 0.14.0 (2026-11-15)

- After a move, the VS Code panel shows the new account. The extension reads the account, plan, models, commands and Remote Control state from a process it starts itself, and a process cca-stream relaunched behind its back got none of that: the panel kept the old account's details, and showed Remote Control as connected while the new process ran none. Now, when a move leaves nothing to carry on (no follow-up, no background work, no scheduled wakeup, not parked, nothing in flight), the tab's process ends quietly and the panel starts the conversation at the next message on the new account, with its whole startup. A move with work to carry on reopens at once as before, and ends the same way once that turn is done. `CCA_REFRESH=off` keeps every move a reopen in place. The Stop hook now records how many wakeups a session holds.
- A hot reload of the plugin keeps a queued switch and the background work it waits for. Every update reloads the plugin in running sessions, which started their switching state afresh: a queued switch was lost and the conversation recorded back on the old account, and the next `/account` switched at once and stopped background shells. A refused session's minute check, which the reload cancelled, starts again.
- Moves count the moving session's own weight, so a weighted session, or any session moving onto a Pro plan, no longer arrives at a window it fills and is sent straight back at every turn's end. A session with no reading of its own yet goes by its account's saved one instead of taking every week for sooner. A window resetting within minutes keeps a session only when every full window does.
- Pruning leaves a transcript that Claude Code rewrote meanwhile as it is. Claude Code's own compaction renames a new file over a transcript, and removing a row truncates it in place; a prune running then lost the rows written to the new file, brought back a removed row and garbled the next, or left an empty transcript. A row nested past Python's recursion limit stopped every later prune; that transcript is now reported once. A kept request keeps the request it builds on. An active transcript is passed by while unchanged until it turns idle, instead of being read whole at every session start, a linked project folder is pruned once, and a reload prunes nothing.
- Budgets: another session's late reading of last week no longer counts as this week's rise, which made points look larger and parked projects within budget. A folder key with a trailing slash matches its folder. `/account budget` and `/account priority` take a quoted folder, as the README writes it. A session's spend is kept by the folder it was spent in, so a session that moves no longer takes the day's spend to its new project. A session on a login cca does not hold is neither counted nor parked. A session-list entry read mid-write no longer drops a parked session's record. A sliver of room wakes one parked session of a project at a time. `cca spend` files a `//` folder under its folder and starts a damaged record again instead of failing every call that day.
- cca-stream reads a large panel line in linear time (a 50 MB pasted image took 9 s), drops a queued message the panel cancelled, replays a setting held during a switch once, and reads a new child's output before writing to it. A claude cca starts from a desktop session no longer runs as a desktop session. cca-sync writes a `.claude.json` holding a lone surrogate escape instead of failing on it every start.
- Desktop sessions: `/account` there records nothing, the status line's cannot-move note outlives later readings, and a session that recovers is told again when its window next fills.
- Spend and calibration move to `spend.ts`, the `/account` command to `command.ts`, and the transcript row model to `transcript_rows.py`.

## 0.13.1 (2026-11-15)

- A Claude desktop session counts on the account the app signed it in to. The desktop app starts Claude Code itself and hands it its own login, naming the account in `CLAUDE_CODE_ACCOUNT_UUID`, while the config dir stays `~/.claude`. The plugin named the account by the config dir, so on 2026-11-15 every desktop session saved another account's 100% five-hour reading under `~/.claude`'s, and the sessions in VS Code kept off an account they could have used. The plugin now matches the host's account id against each account's login record; a login no account holds saves no reading.
- A session nothing can move says so. The balancer passed over a session cca did not start without a word, so a desktop session sat at its limit with no hint of the accounts that had room. It now stays and says once per full window why it cannot move, which account has room, and how to go on there: in VS Code with `/account`, or with `cca <account> --resume <id>`. `/account` in the desktop app says the same instead of promising the conversation opens on the other account.
- A claude started from a desktop session runs on the account cca picks. Such a session leaves the app's login token in the environment of the commands it runs, and Claude Code uses that token over the account's own login; cca now drops the host's login variables when it starts Claude Code on an account.

## 0.13.0 (2026-11-15)

- A parked session goes on by itself once its project is within its allowance again. A refused session went idle, told to stop, and nothing started it again: it stayed parked after the allowance caught up, the day turned, or a budget was raised, until a person wrote to it. Now a session whose tool call was refused leaves a record in `parked/`, checks every minute, and is told to carry on when its project may spend again; every other session's turn end and `/account budget` or `priority` wake it too, at once for a change made with `/account`, and reach a session whose plugin was reloaded. A session is woken once, whoever notices first. The parked message tells the model it will be told when it may go on.

## 0.12.2 (2026-11-15)

- The copy a tool's result keeps of an image goes with the image. A Read of an image stores it twice, in the message and again in `toolUseResult.file.base64`, which the API never sees; the prune replaced the first and left the second, 273 MB in 1,029 rows after 0.12.1's sweep. Once a row shows none of its images, its copy loses them too (a Read result's `base64` emptied, as Claude Code's own slim mode writes it), and a copy no longer counts among the newest five, which a tool result's own image blocks had made fewer.
- A transcript looked at while still active is looked at again. The state recorded every transcript it saw, so one seen within its hour of activity and never changed after kept its request log for good; it now records a transcript only once it was idle when looked at.
- A prune stopped by SIGTERM, as a reload of the plugin stops it, goes to the debug log instead of being reported as a failure, and the state file's temporary copy is removed if writing it fails.

## 0.12.1 (2026-11-15)

- A conversation is idle by its newest row's own time, not by the file's. 0.12.0 judged idleness by the file's mtime, and the first sweep had just rewritten 203 files, so 1.2 GB of request log in conversations idle for days counted as active and stayed. An idle conversation is also rewritten for a saving of 64 KB, not 1 MB: it is rewritten once and the state then passes it by, and the 1 MB floor had left 300 files and 117 MB alone. The 1 MB floor still holds for a conversation active within the hour.

## 0.12.0 (2026-11-15)

- Pruning reaches every conversation that needs it. After 0.11.0's first sweep took 30 GB to 3.5 GB, 1.7 GB of what was left was the request log, and most of it in subagents' files, which never compact: a copy of each request, kept so Claude Code can resend it byte for byte while the prompt cache lasts, which its loader ignores when it rebuilds a conversation. A transcript idle for an hour, the cache's life, now loses its whole request log; one active within the hour still loses only what no request since its last compaction builds on. A message a fork started from (its `fork-context-ref`) is kept with its parents, since Claude Code reads it back to rebuild the fork. The sweep looks at transcripts from 1 MB, the least that can save the 1 MB a rewrite needs, instead of 10 MB, which had left 78 files and 189 MB alone. The state file records the rules' version, so a change of rules looks at every transcript again.

## 0.11.0 (2026-11-15)

- Conversations are pruned to their last compaction and their newest images. Claude Code resumes a compacted conversation from its last compaction but keeps everything before it in the file, and screenshots pile up in conversations and in subagents' files. On 2026-11-15 they came to 30 GB on one machine, one conversation to 2.3 GB and one subagent's file to 495 MB, nearly all images, and the editor and desktop app read a conversation's file whole to open it. Each session now prunes, at its start, every conversation file of 10 MB or more that changed since the last look, and its own (subagents' files included) once a turn in which it compacted ends. The conversation before the last compaction goes, but for the messages the compaction kept, and so do the request log's rows that no request since builds on; every image but the newest five in a file becomes a line saying it was removed. On the largest files this took 977 MB to 127 MB and 27 MB to 2 MB, and a pruned conversation resumed with the same summary and last message as the original. The prune runs beside the session, one at a time on the machine, replaces a file atomically and carries over rows written meanwhile. `CCA_PRUNE=off` stops it. Rewinding past the last compaction is no longer possible once it has run.

## 0.10.0 (2026-11-15)

- An update to the plugin reaches running sessions by itself. Claude Code reloads a plugin whose folder changes only where it watches the folder, and a headless session, which is how the desktop app and SDK clients run it, does not watch by default. On 2026-11-15 a desktop session kept running 0.9.0's code after 0.9.1 was installed, and was parked by the bug 0.9.1 fixed until `/reload-plugins`. `cca init` now sets `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` beside `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, and `install.sh` adds it on an update where the plugin is loaded and it is not set; a value the person set is kept, and `cca uninstall` removes only the `1` it set. Then a session loads a changed plugin once its turn ends. A session started before the setting reads it at its next start.

## 0.9.1 (2026-11-15)

- A session counts in, and is parked by, the folder it works in, not the one it started in. The Claude desktop app starts a session in a standby folder under `~/.claude/spares` and then moves it to the folder the person picked, but the plugin kept `session.start`'s folder for the session's life. Each desktop session was then a project of its own with no budget, so its spend fell outside its real project's budget, and once the budgets set took the whole supply it was parked after its first turn. On 2026-11-15 a session working in a budgeted project with room was parked as `spare-pxm3AD`. The plugin now reads `$.session.root()`, which follows the move, wherever it needs the session's folder: its spend record, parking, its weight, and `/account budget` or `priority` with no folder named.

## 0.9.0 (2026-11-15)

- Sessions opened in the Claude desktop app without a folder get an allowance. Each starts in a scratch folder of its own under `~/Library/Application Support/Claude/scratch-workspaces`, so each was a project with no budget, sharing what the budgets leave. Once the budgets set add up to more than the accounts supply, that share is nothing, and on 2026-11-14 such a session was parked from its first turn. Now, while any budget is set, all of them count as one project, that folder, with a default budget of 5 points a day. `/account budget <points> "~/Library/Application Support/Claude/scratch-workspaces"` changes it, and 0 brings the default back. The budgets table marks the row "default for sessions with no folder". With no budget set, nothing is parked, as before.

## 0.8.2 (2026-11-10)

- A move waiting for a session's background work goes at once when the account then stops a turn. The balancer skipped every turn's end while a switch was pending, so a planned move queued behind background work never became a forced one. On 2026-11-10 a session holding gate waits queued a move off an account, then hit that account's weekly limit, and every message it received ended on the limit while the status line read "moving". Now a stopped turn forces the pending switch to the account it was waiting for, stopping the work and naming it in the follow-up, whether the balancer or the person asked for it. A turn that ends on an error not of the account leaves the move waiting.

## 0.8.1 (2026-11-10)

- Sessions spread before an account's five-hour window stops them. 0.8.0 sent every move and new session to the account whose week resets first while its five-hour window was below the take line, however many sessions already worked on it, and counted idle sessions as load. On 2026-11-10 about twenty sessions ran on one account; its five-hour window went from 70% to 100% within single long turns, and since the balancer runs only at a turn's end, sessions such as a project's QC and a studio's director learned of the limit when it stopped their turn, with another account fresh from its reset beside it. Now an account has room only while its five-hour use plus 10 points per unit of working load stays below the bar, and an account with room comes before the week that resets first; an unmeasured account has no room known and stays a last resort. A session moves, planned, when its own account's use plus that count reaches 90%, to an account with room. A session idle for 30 minutes or more by its registry status counts as no load, and nothing makes room for an idle heavier session.

## 0.8.0 (2026-11-09)

- Room is spent before the week that holds it resets. A week's unused room is lost at its reset, but sessions went to the account with the most five-hour room and new sessions started on the default, so on 2026-11-09 new sessions started on an account fresh from its reset while another's week, resetting two days later, still had a quarter of its room. Now a move, planned or after a stopped turn, takes the account with room whose week resets first; among weeks resetting at the same moment it takes the one with the most five-hour room, counting the load already on it, as before. New sessions start on the account a move would pick, the default winning among weeks that reset together and when no reset is known. With nothing pressing on its account, a session also moves at a turn's end to an account whose week resets at least six hours before its own and has room below the take line; an account with no known reset never draws such a move. `cca` and `/account` mark a default new sessions pass over as "passed over", since it may have room and still wait for an earlier week.

## 0.7.1 (2026-11-09)

- A client's calls on an account that no session measured that day stay out of calibration. Only Claude Code sessions report an account's readings, so an account only an LLM bridge uses has no calibration record, and its tokens made every point look larger and every project's spend read low. On 2026-11-09 a project's recall run moved onto such an account. Its calls still count in their project's budget. A client record without the account it called is no longer read.

## 0.7.0 (2026-11-08)

- `cca spend` counts a call that a client outside Claude Code made, such as an LLM bridge signed in to one of the accounts: `cca spend <model> <input> <output> <cache_read> <cache_write> --project <folder> --account <name or email>`. The call's tokens count in the project's budget and in calibration like a session's turns. Asked for on 2026-11-08, when a project's chat moved onto a bridge on one of the accounts. Its use would otherwise have raised that account's readings with nothing counted beside it, so every project's tokens would have read as more points than they are. Calls running in parallel all count. Raw counts are kept per model, and the plugin weighs them as it weighs a session's turns.

## 0.6.1 (2026-11-08)

- A session's older reading of an account's week no longer counts as a new week. Calibration took any reading lower than the last as a reset and added the whole reading to the day's points. On 2026-11-08 two sessions on one account reported 40% and then 39%, and the day's record counted 42 points where the account had used 9. That made a point worth a third of the tokens it is, counted Wazeem Studio's 7.6 points as 24 and parked all its sessions within their budget. A new week is now told by its reset moment, which a calibration record keeps: only a reading whose week resets at least a day later starts counting from zero. A lower reading of the same week adds nothing, and the next rise counts from the highest.

## 0.6.0 (2026-11-07)

- Project budgets. `/account budget <points a day> [folder]` holds a project to so many points a day, a point being one percent of a Max 5x week; projects without a budget share what the accounts supply beyond the budgets, by their weights. Every session counts what its turns cost, weighted by model, and the accounts' own readings calibrate tokens to points. A project over its allowance so far (a quarter of a day ahead of the clock) has its sessions parked between turns: their tool calls are refused with the figures and when the day turns, and they go on by themselves once the allowance catches up. A turn in flight is never cut. `/account usage` ends with the budgets table. `CCA_BUDGET=off` turns parking off. Asked for on 2026-11-07, when two projects sharing five accounts needed one to last the week beside the other's daily films.

## 0.5.4 (2026-11-07)

- Sessions use an account's week to 99%, not 95%. The owner's call on 2026-11-07: every account is to be spent in full, and a turn stopped at the limit already moves on. A session now leaves at 99% of its week (was 95%), a planned move takes an account below 97% (was 90%), and a lighter session makes room for a heavier one from 95% (was 90%). The five-hour thresholds are unchanged. A move at 99% leaves about one point of room, so a long turn can still hit the limit mid-turn; the stopped-turn move then carries it on.

## 0.5.3 (2026-11-06)

- New sessions start on an account with room. They used to start on the default account whatever its usage: on 2026-11-06 that was an account at 99% of its week, so every new session ran its first turn there and moved only after it. The plugin now writes where a new session should start (`accounts/start`) at the end of every turn: the default while it has room, else the account a move would pick. cca starts new conversations there. A default you set afterwards wins until the next turn's end. `/account`, `/account usage` and `cca` show where new sessions start.
- A session whose shell folder had been deleted (a worktree it removed) could not save its usage or move: every command cc-accounts ran started in that folder and failed. They now run from `/`.
- A turn stopped by a per-model limit or a lost login is recognised again when Claude Code writes up to a dozen rows after the error, as 2.1.318 does, or when a screenshot row comes before it. The transcript's last megabyte is read, not its last six lines.
- After a switch in VS Code, nothing the panel or the old process asked is left waiting. A setting the old process never answered is replayed under the panel's own id. An interrupt is answered, since the turn has ended. Any other open request goes to the new process. A permission prompt the old process left open is withdrawn.
- A failure in a session's start, a turn's checks or `/account` is reported in the session log or the reply, not dropped silently.
- Two saves of one file from one session can no longer collide, a priority folder typed with `.` or `..` matches the folder sessions report, and `/account usage` calls an account spent at the same 99% the balancer uses.

## 0.5.2 (2026-11-06)

- A switch no longer doubles the session's scheduled wakeups. Claude Code now restores them itself when the conversation is resumed, but the follow-up still listed them and asked the conversation to set them again, so each move added a copy. On 2026-11-06 a one-shot job that posts a YouTube comment was doubled this way. The follow-up now only says why a turn stopped or was cut, and a planned move sends none.
- A VS Code tab opened before cca-stream moves at the leave line even when it holds wakeups. It used to stay until the limit stopped a turn, to keep wakeups it keeps anyway. `/account` no longer warns that such a switch ends them.

## 0.5.1 (2026-11-06)

- The balancer's log lines name each window with its figure: "levoro's 5-hour window is at 46% and its weekly window at 95%; moving this conversation to ceo-team". Before, "levoro's weekly window is at 5h 46%, week 95%" read as if the weekly window were at 46%. The status line keeps its short form.

## 0.5.0 (2026-11-06)

- Projects can matter more than others. `/account priority 3` gives the project you are in a weight of 3, and `/account priority 0.5 <folder>` gives any folder one. The weights live in `~/.claude-shared/accounts/priorities.json`. When a session picks an account to move to, each session already there counts by its project's weight, so lighter projects keep off the accounts heavier ones use. On an account past 75% of its five-hour window or 90% of its week, a session of a lighter project moves off when a heavier one shares the account, leaving the rest to it. It moves only to an account with plenty of room.
- A bigger plan carries more sessions: an account's load is divided by its plan size, read from its login record (a Max 20x counts four Max 5x plans).
- `/account usage` shows what is free on every account and when it resets, the sessions on each account, the projects and their weights, and the totals in Max 5x plans: free now, and free before sessions start moving off. `/account` ends with the total free.
- cca refuses the account names `default`, `usage`, `priority` and `now`, which `/account` reads as its own words.

## 0.4.6 (2026-11-06)

- New `cca remove <name>`, for an account whose plan has ended. It takes the account out of the table, so no session starts or moves there, and drops its usage reading and failure records. Its folder and login stay, so `cca add <name> <folder>` brings it back. It refuses `~/.claude`, which every account links, and the account new sessions start on.
- A refusal that does not clear on its own keeps sessions off the account for a day, not an hour. That covers a lost login, an organization that turned off Claude Code on its subscription, a hold and a billing failure. Before, every session that needed to move tried such an account again each hour. A usage limit is still tried again after an hour.

## 0.4.5 (2026-11-06)

- A per-model limit now holds back only sessions on that model family. Before, an account that hit its Fable cap was skipped for an hour by every session, including those on Opus or Sonnet, for which it still had room. The failure is recorded under the family of the session's model, `blocked/<account>/<family>.json`. A lost login, a hold or a billing failure, or a limit whose family cannot be told, still holds back every session (`blocked/<account>/account.json`).
- A usage limit the readings show (a 5-hour or weekly window at its limit) leaves no failure record. The readings already show it to every session, with its reset time, and an hour-long record could outlast a reset minutes away.
- cca removes day-old failure records along with day-old background records.

## 0.4.4 (2026-11-06)

- A session stopped by a limit the usage readings do not show now moves. That covers a per-model weekly cap (on 2026-10-26 one conversation hit its Fable limit 23 times in a row and stayed) and a login the account lost. The balancer reads the error class Claude Code writes to the transcript (`rate_limit`, `authentication_failed`, `billing_error` and the like). That class means the same as the StopFailure hook's word, but StopFailure only runs after the turn has completed.
- A session the limit stopped takes any account below the leave line, 90% of five hours or 95% of the week. Before, it waited for one below 70% and 90% and stayed stopped when none was.
- An account that failed a call for a reason of its own is skipped by every session for an hour, so sessions cannot bounce between accounts that both hit a per-model limit.
- A planned move is skipped when the full window resets within 15 minutes. A move makes the new account read the whole conversation uncached, and a limit hit in those minutes still moves at once.

## 0.4.3 (2026-11-06)

- A message sent as a switch begins is no longer lost. If the old process never took it, cca-stream sends it to the new one. If the switch cut short the turn it started, the reopened conversation is told to carry on.
- Scheduled wakeups are handed over with their prompts whole, including one set in the turn the usage limit stopped. They are read from CronList when the switch happens. The Stop hook's list clips prompts at 1000 characters and is not sent for a turn the limit stops.
- A VS Code switch now keeps every option the panel passed except those that pick the conversation, and that list is the one a terminal relaunch uses. Before, `--resume-session-at`, `--resume-drops-turn` and `--from-pr` survived a switch and could reopen the conversation at an old message.
- A move the usage limit forces ends the process once. Two timers could both carry it out and signal the process twice.
- A switch that cannot end its process is withdrawn, so the panel no longer hangs with its input held.
- Usage readings, conversation records and the default account are written to a temporary file and renamed into place, so a reader never takes a half-written reading for an empty account.
- `/account` in a VS Code tab opened before 0.4.0 names the wakeups the switch will end. The 0.4.1 entry said those wakeups were handed over; for such a tab they never were.
- Only a stream-json session runs under cca-stream. `cca <claude binary> ...` typed in a terminal runs Claude Code itself again.
- The shell tests unset `CCA_SHARED`, which a session started by cca 0.4.0 or later passes to the tests it runs.

## 0.4.2 (2026-11-06)

- The balancer prefers an account whose usage a session has reported over one nobody has measured. An unmeasured account was scored as empty, so a move could land on one that was itself nearly spent and bounce again; it is now a last resort.

## 0.4.1 (2026-11-06)

- A switch no longer loses the session's scheduled wakeups (`/loop`, ScheduleWakeup, CronCreate) without a word. The Stop hook now records them, and the reopened conversation gets a message listing each one to schedule again. This covers `/account` as well as the moves 0.4.0 added. A VS Code session started before 0.4.0 cannot get that message, so it keeps its wakeups and moves only when the limit stops a turn.

## 0.4.0 (2026-11-05)

- Sessions move off an account before its usage limit stops them. Every session saves its account's five-hour and weekly usage to `~/.claude-shared/accounts/usage/<account>.json`, so each one knows the accounts it is not on. At the end of a turn, a session whose account is at 90% of its five-hour window or 95% of its week moves to the signed-in account with the most room, counting the live sessions already on each so that sessions leaving together spread out. It waits for its background work as `/account` does. A turn the limit itself stopped moves at once and reopens with a message telling the conversation to carry on, naming any background work the move stopped, so the work continues with nobody typing. `CCA_BALANCE=off` turns the moves off.
- In VS Code a switch no longer waits for your next message. The wrapper keeps the panel's process alive (`libexec/cca-stream`), starts Claude Code under it, and when a switch ends Claude Code, starts it again on the new account in the same tab, replaying the panel's session setup.
- In a terminal, a switch that carries a follow-up reopens the conversation with it as the first prompt.
- The status line and `/account` show each account's last usage reading.
- `/account` no longer cuts work short. Ending the process for a switch stopped the turn in flight and every subagent, Monitor and background command, which then had to be resumed by hand. A switch now waits until the turn has ended and the background work has finished, replying at once with what it waits for, and happens on its own when the last task's notification turn ends. `/account <name> now` switches at once; `/account <current account>` cancels a queued switch. The plugin learns the session's background work from a Stop command hook, `record-tasks.py`, because hooks modules do not get the Stop event where the built-in security plugin is seated.
- `cca help` prints the whole comment block however long it is.

## 0.3.1 (2026-10-24)

- In VS Code, `/account` on a session in the middle of a turn ended the turn instead of the process, so the conversation ran twice: the old process beside the one the panel started on the new account. The switch now waits for the process to exit, sends SIGINT again to the now idle session, and SIGTERM last; a process that survives is reported in the session log.

## 0.3.0 (2026-10-23)

- User MCP servers live in one file, `~/.claude-shared/mcp.json`, which every session cca starts loads with `--mcp-config`. Server names, and so tool names, stay the same. At each start cca moves the user servers an account holds into the file, so no account keeps a copy; one added later with `claude mcp add --scope user` on any account is moved in the same way. Edit the file to change or remove a server. Before, 0.2.0 kept a copy in every account.
- `CCA_MCP_SYNC=off` stops the moving and the per-project sync; the file is still loaded.

## 0.2.0 (2026-10-23)

- MCP servers are the same on every account: user servers, a project's local servers, and your answers about a project's `.mcp.json` servers. A server added, changed or removed on one account changes on the others when they next start. Before, each account kept its own, so a session's tools depended on its account. `CCA_MCP_SYNC=off` turns this off.
- Folder trust and MCP servers sync before VS Code sessions start too, not only in a terminal. Without trust, VS Code sessions skipped an MCP server's `headersHelper` and the MCP servers and hooks an agent definition brings.
- Auto memory writes no longer ask for permission. Every account reached its memory through the link to the shared conversations, and Claude Code compares a memory write's real path with the memory folder's configured path, so the two never matched. cca now names the folder by its real path.
- `cca add` refuses a folder another account already uses.
- A preference saved from VS Code with an empty account table runs once instead of failing.
- The plugin's version matches the release again.

## 0.1.2 (2026-10-22)

- VS Code: the Claude in Chrome and memory dialogs save their setting to every account. Before, the extension's helper run went to the default account, so a panel on any other account kept reporting Claude in Chrome off and never connected it.

## 0.1.1 (2026-10-20)

- VS Code in WSL or over SSH: setup now sets the process wrapper in the editor server's machine settings, where a remote window reads it. Before, `/account` did not reach those windows.
- Setup also covers an editor that is installed but has no settings file yet.
- fish: setup writes fish syntax to `config.fish`. Other unknown shells get the lines to add.
- Running `cca init` again while Claude Code is open works; it only asks you to quit when it has folders to move.
- `install.sh` explains how to use WSL when run on Windows outside it, says "Updated" when run again, and installs a tag without git's detached-HEAD notes.
- The README is shorter, with step-by-step setup and Windows instructions.

## 0.1.0 (2026-10-20)

First release.

- `cca` runs Claude Code on several accounts, each its own config directory, with conversations, the session list and settings shared between them.
- `cca init`, `cca add`, `cca use`, `cca uninstall` and `install.sh` set it up and take it down.
- `claude --resume <id>` opens a conversation on the account it last ran on.
- The `/account` plugin moves a conversation to another account: in a terminal it reopens in place with the same options; in VS Code (and Cursor, Windsurf, VS Code Insiders, VSCodium) the next message continues on the new account.
- Folder trust is synced between accounts.
