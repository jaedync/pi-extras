# Examples

## A quarterly business review with a churn problem

The user asks: "Update the slides in our QBR template with this quarter's
numbers."

Depth:

- An expert finds out what changed this quarter, why, and what to do about it.
  Filling in a template does not do that.
- Raw material: the event logs, the billing and the support tickets, not the
  numbers already pasted into last quarter's slides.
- Instruments: load the data into a database (DuckDB or SQLite). Fit a
  survival model for churn. Make the charts from code, not by hand.
- Test a belief: "churn is an onboarding problem". Reproduce it from the raw
  logs, or show that it is false.
- Find something new: model last year's customers from the logs, find the
  earliest churn signal that nobody knows about, and show that it predicts on
  a quarter that the model did not see.
- Outside check: the held-out quarter, and a second person who reruns the
  queries from the scripts.

Altitude:

- The review exists so that leadership finds problems early and moves money
  and people to the right places. Design a better way to do that than a
  quarterly deck. Show from the company's own history that it would have
  found problems sooner. Run it beside the current review for one quarter.
- Access needed: read access to the warehouse, the ticket system and the
  billing system.

Range:

- Verbs: get busy people to believe a cause, and to decide with uncertain
  data, in 30 minutes.
- Fields: an analyst (causal inference), a journalist (lead with the single
  finding that matters), an editor (cut everything that does not serve the
  decision).
- Adversarial: a forensic accountant reconciles every number with the ledger.
  A short seller looks for the weakest claim and tries to break it.

The rewritten prompt:

> From the raw event, billing and ticket data, find what changed this quarter
> and why. Load the data into DuckDB and fit a survival model for churn. Test
> the belief that churn is an onboarding problem. Find the earliest churn
> signal that we do not track, and show that it predicts the held-out quarter.
> Give the three most urgent decisions, each with the arguments for and
> against. Reconcile every number with the ledger, and list each claim that
> failed an attempt to break it. Then build the slides from those results.

## A slow page

The user asks: "Make the dashboard load faster. It takes 10 s."

- Depth: profile first (browser performance trace, server spans, query
  plans), not guesses from the source. Target 200 ms. Outside check: a
  repeatable load test with p50 and p95 before and after, on the same data.
- Altitude: keep every page under a performance budget. Add the load test to
  CI so that a regression fails the build.
- Range: a database engineer reads the query plans and the indexes. A network
  engineer reads the waterfall. The adversarial check is a cold cache, a slow
  network and the largest real customer's data.
