// Emulator fixtures of the Firestore TugQL pushdown tests
// (spec firestore-tugql-pushdown in dal-go/dalgo). Each fixture is a map of
// document path to document data, written into an otherwise empty database.

export type Documents = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

const ACTIVE = new Set([7, 23, 41]);
const PAUSED = new Set([3, 15, 30, 44]);

/** The 1-based item number as two digits, so titles and ids sort numerically. */
export function itemNumber(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * 50 documents `items/item-01` … `items/item-50`: distinct titles
 * `Title 01` … `Title 50`, 3 `active` and 4 `paused` statuses (the rest
 * `done`), and small integers `a` and `b` for the OR query of the opt-in golden.
 */
export const items: Documents = new Map(Array.from({ length: 50 }, (_, index) => {
  const n = index + 1;
  const status = ACTIVE.has(n) ? "active" : PAUSED.has(n) ? "paused" : "done";
  return [`items/item-${itemNumber(n)}`, { title: `Title ${itemNumber(n)}`, status, a: n % 4, b: n % 6, rank: n }];
}));

/** Five `items`, one of which (`items/untitled`) has no `title` field. */
export const itemsOneUntitled: Documents = new Map<string, Record<string, unknown>>([
  ["items/e", { title: "Echo" }],
  ["items/b", { title: "Bravo" }],
  ["items/untitled", { status: "draft" }],
  ["items/d", { title: "Delta" }],
  ["items/a", { title: "Alpha" }],
]);

/** One user, one personal space and two DataTug projects with saved queries. */
export const myData: Documents = new Map<string, Record<string, unknown>>([
  ["users/u1", { names: { firstName: "Alex" }, email: "alex@example.com" }],
  ["users/u2", { names: { firstName: "Other" } }],
  ["users/u1/ext/datatug", { projects: { p1: { title: "Zeta" }, p2: { title: "Alpha" } } }],
  ["spaces/s1", { title: "Personal", type: "private" }],
  ["spaces/s2", { title: "Someone else's", type: "private" }],
  ["spaces/s1/ext/datatug/projects/p1", { title: "Zeta" }],
  ["spaces/s1/ext/datatug/projects/p2", { title: "Alpha" }],
  ["spaces/s1/ext/datatug/projects/p1/queries/q1", { title: "Users", text: "from users" }],
  ["spaces/s1/ext/datatug/projects/p1/queries/q2", { title: "Spaces", text: "from spaces" }],
  ["spaces/s1/ext/datatug/projects/p2/queries/q3", { title: "Other project", text: "from items" }],
]);

/**
 * The five queries of `datatug/my-data` (datatug/queries/my-data/*.query.tugql
 * at 1bae8e2), copied verbatim.
 */
export const myDataQueries = {
  "my-user-record": "from users\nwhere __key__ = @SneatUserID\n",
  "my-datatug-settings": "from users/{SneatUserID}/ext\nwhere __key__ = 'datatug'\n",
  "my-personal-space": "from spaces\nwhere __key__ = @SneatUserPersonalSpaceID\n",
  "my-projects": "from spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects\norder by title asc\n",
  "project-queries": "parameters (\n  @projectId string required\n)\nfrom spaces/{SneatUserPersonalSpaceID}/ext/datatug/projects/{projectId}/queries\n",
} as const;

/** Sample DataTug context variables of the my-data fixture. */
export const myDataContext = { SneatUserID: "u1", SneatUserPersonalSpaceID: "s1" } as const;
