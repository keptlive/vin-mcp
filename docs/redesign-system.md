# Unified vehicle workspace: implementation decisions

25 October 2026. Design and implementation notes for the unified workspace.

## Structure

The root page owns the complete product. VIN reports, comparison, specifications,
safety records, ownership costs, saved/recent vehicles, data coverage and developer
tools are views in one persistent shell. Moving between views keeps entered data
and completed results. The current report is visible as a compact vehicle context.
Existing `/research/` URLs redirect with query and hash intact; a bare research URL
opens specifications. `#mcp-info` continues to open developer tools. Direct VIN
paths still load the report.

Saved vehicles and recent reports now occupy a normal workspace view. The header
keeps Saved vehicles separate from sign-in/account controls at every width. The
signed-out view explains the account requirement and offers sign-in. This removes
the former competing fixed drawers and login elements. Rename, delete, report and
comparison actions are available from each saved vehicle. Recent history stays
local to the browser. Account settings and label editing use focus-managed dialogs.

## Visual rules

- Reading surface: warm pale gray (`#f4f5f1`), white form/results surfaces, dark green
  text (`#172f2b`). Forest green (`#216251`) marks actions and selection. Source and
  status semantics remain independent of color.
- Typography: system sans for text; system monospace for VINs and code. No external
  font request is necessary. Sizes vary by role; tabular numerals align data.
- Layout: a 216px navigation column at wide widths, a single content column with
  collapsed task navigation below 800px. Forms and results stack by content priority.
- Forms: native inputs and explicit labels. Persistent status text explains pending,
  failed and completed operations. Data tables scroll within their own container.
- Motion is optional and respects reduced motion. Focus is visible and dialogs trap
  keyboard focus, restore it on close and make the background inert.

## Preserved capabilities and connections

All report cards, photo views, raw-data filtering, recall/provider distinctions,
complaint expansion, configuration subqueries, evidence pagination, ownership
charts/amortization, JSON exports, printable sheets and educational links remain.
Developer tools now show the complete grouped MCP registry from `/api/tools`, plus
remote/local configuration, REST routes, API console, JavaScript client and CLI.
The unversioned npm example was removed from current setup guidance because this
source release has not been published to npm; remote and source configurations are
the current-release connection paths.

Report actions carry a VIN into comparison and its model/year into evidence search.
For costs, only a known gasoline MPG is copied. Electric MPGe is never substituted
for kWh/100 miles; the interface tells the user to enter the correct units.

## Truth and recovery

Existing cost and catalog revision guards remain. Comparison and safety searches
also reject late responses and clear results after edited inputs. A new VIN request
clears the old report; newer input invalidates a pending response. Failed account
mutations do not remove a saved vehicle or claim a preference was saved.

Print output contains the selected workspace view, sources and relevant assumptions.
Cost/comparison printing requires a current result. A VIN report must match the
entered VIN. Raw NHTSA rows print only when the user has expanded that section.
The older information-sheet PDFs keep their explicit preparation date and release
scope; a UI redesign does not imply those source statements were refreshed.

## Evidence

Desktop and mobile visual checks are captured by the parent implementation session
under `outputs/vin-research/redesign-20261025`. The agent reviewed the saved-vehicle
desktop/mobile and mobile comparison screenshots during implementation. Final
browser, keyboard, print and deployment results belong in the verification receipt.
