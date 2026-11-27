# Ticket: {{TITLE}}

You are implementing one well-scoped backend piece of a larger change. Another engineer owns the frontend and the overall design; stay within this ticket.

## Context
{{CONTEXT}}

## The contract you must satisfy
{{CONTRACT}}

## Your scope
{{SCOPE}}

## Out of scope
{{OUT_OF_SCOPE}}
Do not change files outside your scope. If the contract seems wrong or impossible, stop and explain in your final message instead of improvising.

## Done means
- Code implements the contract exactly (names, types, status codes, errors).
- Unit tests for your code, passing: `{{TEST_COMMAND}}`
- Your sandbox may block network ports. Still write tests that start a server; in the receipt, list exactly which tests you ran for real and which you could not run.
- No secrets, debug output or unrelated refactors.

## Final message (your receipt)
End with a report under these headings: **What I built**, **Files changed**, **Tests run and results**, **Deviations from the contract (if any) and why**, **Things the integrator should check**.
