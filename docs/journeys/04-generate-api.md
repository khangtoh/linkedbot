# Journey 4: Generate a missing API

**Status:** draft. The generator's feasibility is proven in a spike (phase 4) before this journey's
screens are built; this doc may change with what the spike finds.

## Who and when

The owner, wanting data linkedbot cannot read yet ("a company's employee count and industry", "the
experience section of a profile"). They are present for the whole generation, usually a few minutes,
watching and correcting.

## Entry points

- Studio: "Generate an API" from the Library, or "Can't find it? Generate it" at the end of a search in
  the operation picker (journey 3).
- An MCP client: the assistant calls `request_api` with a description. This only records the request and
  returns a studio link; generation starts when the owner opens it. Nothing loads LinkedIn pages without
  the owner present.

## Steps

1. **Describe.** What you want, in a sentence, plus an example input ("a company page URL, e.g.
   https://www.linkedin.com/company/anthropic/"). The screen shows the page-load budget for one
   generation (for example "up to 6 page loads").
2. **Watch.** The live browser view shows the server's browser opening the example page. A step list
   beside it (below it on a phone) fills in as the generator works: open page, find the name, find the
   industry, and so on. Each extracted field appears in an output table with the value it found.
3. **Correct by pointing.** If a value is wrong or missing, tap the field in the table, then tap the
   right thing in the live view. A box shows what was picked; make it wider (the parent) or narrower
   (the child) until it covers the right text, then confirm. The generator updates that field and
   re-checks it on the page already loaded, without a new page load.
4. **Test.** "Test with another input" runs the API on a second example you give. Fields that come back
   empty are flagged.
5. **Name and publish.** The generator proposes a name and description; edit either. Publishing makes it
   an operation: callable from MCP, usable in tools.

## What a generated API can do

Navigate to linkedin.com pages, wait for content, scroll to load more, expand "see more" buttons, and
read text and links. It cannot type, submit, click links, or change anything on LinkedIn. Each run
counts against the daily caps like the built-in operations.

## States

| State | What you see |
|---|---|
| No LinkedIn session | "Log in to LinkedIn first." with a link to journey 1. |
| Browser busy with a job | "Waiting for the current job to finish (search_people)." The generation starts when it ends. |
| Budget used up | "This generation used its 6 page loads." Keep what was found, or start again tomorrow. |
| Field not found | The field shows "not found"; point at it, or remove it. |
| Generator unsure | It asks a question in the step list ("Two numbers look like follower counts. Which one?"). |
| Page needs something not allowed | "This needs a click on a link or a form, which generated APIs can't do." |
| You go idle | After 2 minutes without input the browser is released for queued jobs. The draft is kept; resuming reloads the page (1 page load). |
| Phone screen locked | Returning reconnects and replays the current state. |
| LinkedIn logged out mid-generation | The generation stops, the draft is kept, and the state turns *Needs login*. |

## Success check

- The published API returns correct values for both example inputs.
- It appears as a tool in MCP clients and in the operation picker of journey 3.

## Notes

- Every generation spends Claude API tokens as well as page loads.
- Generated APIs depend on LinkedIn's page structure. When LinkedIn changes a page, an API can start
  returning "not found"; regenerating it from its saved description is the fix.
