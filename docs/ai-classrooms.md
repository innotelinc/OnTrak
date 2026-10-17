# The AI classroom — OnTrak's classes, AthenIQ's generated lessons

A funded class is taught in two places at once. **OnTrak** holds the part a funder pays for:
the tenancy, the program's ceilings and window, the course as it was authored, the roster, the
attendance, the completion, and the report filed on the contract's schedule. **AthenIQ** — the
family's learning platform, `innotelinc/atheniq` — holds the classroom: a generated, multi-agent
lesson with slides, quizzes, interactive simulations, an AI teacher and AI classmates who speak
and draw, served by **OpenMAIC** (`THU-MAIC/OpenMAIC`, MIT) at `classroom.<domain>`.

This page is the seam between the two. Nothing here is required: with
`ONTRAK_CLASSROOM_ENABLED` unset, a class behaves exactly as it did before the seam existed.

## Who owns what

| | Owner | Where it lives |
| --- | --- | --- |
| The funded facts: tenancy, program, price, window, roster, attendance, completion | OnTrak | `Organization`, `Program`, `Course`, `CourseModule`, `Cohort`, `Enrollment`, `Attendance` |
| The classroom specification: one entry per module, with prompt, objectives and activities | OnTrak (generated) | `GET /admin/tenants/<id>/classroom-spec?courseId=…[&cohortId=…]` |
| The generated lesson: the scenes, the agents, the media | AthenIQ / OpenMAIC | `classroom.<domain>` |
| The classroom's **address**, and which class is in it | OnTrak | `Course.classroomUrl`, `Cohort.classroomUrl` |

A classroom belongs to a **course** — it is generated from that course's modules — and a
**class** may override it, because a sitting can be built from the sponsoring employer's own
documents. The class's address wins; the course's is the fallback; a mistyped override is
reported *and* the class still opens the course's (`lib/classroom-rules.ts`, `effectiveClassroom`).

## Configure

```env
ONTRAK_CLASSROOM_ENABLED="true"
ONTRAK_CLASSROOM_URL="https://classroom.innotel.us"   # AthenIQ's own CLASSROOM_HOST
```

Both are required, and the switch is a decision rather than a consequence of knowing an
address. Enabled with no address, or with one that is not an absolute http(s) URL, is reported
as **misconfigured** on the control room's integrations panel, and no class is offered a door —
the same stance the lab's settings take.

The host itself is not started here. Bring OpenMAIC up where AthenIQ says to —
`services/OpenMAIC` in that repository, `docker compose up -d --build`, with
`OPENAI_BASE_URL` pointed at the platform's single OmniRoute gateway and a long random
`ACCESS_CODE` for a shared deployment — and front it at `classroom.<domain>`. OnTrak never
holds a model key, an `ACCESS_CODE`, or the classroom's database credentials.

**The link carries no identity.** That host signs its own visitors in (Authentik's
`atheniq-classroom` client, or the site-level `ACCESS_CODE`). No subject, learner id, address
or token is ever added to the classroom link, so there is no second, weaker identity path for
the family to trust — the same refusal the lab's door makes.

## Generate a classroom

1. **Author the course first.** The specification is built from `CourseModule` rows: each
   module's objectives, the activity the learner does, and how the module is assessed. A course
   with no modules generates a spec with no classrooms, which is worse than none — so
   `/admin/tenants/<id>` says so rather than offering the file.

2. **Download the specification.** On `/admin/tenants/<id>`, a course card (or a class card)
   shows the generated document and a link to download it as `<course-slug>-classrooms.json`.
   It is AthenIQ's own shape — `version`, `provider`, `gateway`, `source_course`, `locale`,
   `defaults`, and one `classrooms[]` entry per module with `id`, `title`, `prompt`,
   `objectives` and `activities`.

   The file is generated from the course rather than authored twice on purpose: an instructor
   who adds a module to the course and forgets to regenerate the classroom has a class assessed
   on material it was never taught.

3. **Submit it to the classroom host.** AthenIQ's `courses/<slug>/openmaic/README.md` describes
   the step: *"For each entry in classrooms.json, submit prompt, objectives, and the defaults
   agent roles to OpenMAIC as the lesson brief."* That can be done by hand in the host's own
   home page, from chat through the OpenMAIC skill, or by dropping the file into an AthenIQ
   course's `openmaic/` directory — the choice belongs to whoever operates the host.

4. **Paste the classroom's address back.** On the course card it becomes the classroom every
   class of that course is taught with; on a class card it becomes that sitting's own. Both
   accept http(s) only, and refuse an address carrying a username and password — a credential in
   a field every member of the class can read, that the roster export prints and the audit log
   keeps, is not a credential.

5. **Learners enter from their own page.** `/student` lists the classes that have a classroom,
   with a door to it, and `/instructor/cohorts` shows each class's classroom to the person who
   teaches it.

## The two fields OnTrak deliberately does not write

An AthenIQ classroom spec also carries `chapter` and `linked_units` — Open edX `url_name`s that
point the classroom at the chapter and units of an OLX package, which is what that repository's
`scripts/check-classrooms.py` validates (along with a `source_course` that must resolve to a
package under its `courses/`). A course authored in OnTrak is not an OLX package, so those two
pointers are omitted rather than invented: a document that looks complete and fails
`make check-classrooms` is worse than one that visibly stops where this app's knowledge stops.
AthenIQ adds them when the course is imported there.

`source_course` *is* written, because a classroom has to be generated *for* something:
`course-v1:<org>+<course>+<run>`, with the org from the tenancy's own slug and the run from the
quarter the training starts, so a second sitting is a second run and the two classrooms stay
distinguishable.

## Limits worth stating

- **Generation is not driven from here.** OnTrak has no OpenMAIC API client: the host's own
  routes and its model settings belong to the deployment that runs it, and a GET this app
  invented would either 404 or start something the host never agreed to. The handoff is a file.
- **The classroom's checks are not OnTrak's grading.** A scenario attempt, a lab session and a
  certificate are unchanged by any of this; the classroom is where a learner practises between
  them, and its quizzes stay inside OpenMAIC.
- **One classroom per course or class.** A per-module address is not modelled, because
  OpenMAIC already scopes a generated lesson by scene and a second level of nesting would only
  invite two addresses to disagree about which one a learner should open.
