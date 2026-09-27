# REVIEW_NOTES

Notes the owner leaves for the run while it is paused. `autoclaude note "<text>"` appends a dated
entry here and puts it on the pending list; on `autoclaude resume` every pending note is injected
into the session under "Owner review notes: act on these first", and Claude records what it did
with each one as an `N-###` entry in `docs/DECISIONS.md`. Use the command: a note typed straight
into this file is kept but never reaches the run. Entries are never edited or removed; this file
is the record of what the owner said and when.
