# The lab's scenarios

The lab's own scenario tree, and the data a host reads. Every scenario is one directory:

```
_lib/OnTrak.Common.ps1      the PowerShell library every scenario dots in
_lib/ontrak-common.sh       its shell twin
<id>/scenario.json          the ticket, objectives, hints and metadata
<id>/setup.ps1 | setup.sh   injects the fault
<id>/check.ps1 | check.sh   grades the student's fix against the live machine
<id>/resources/**           anything those scripts need
```

The scripts are `OnTrak-dev/scenarios/**` copied verbatim — a scenario's check decides
whether a student's fix works, so it is not something a port paraphrases. The
`scenario.json` files are the lab's `scenario.yaml` converted once, field for field, with
the lab's own PyYAML (`docs/lab-port.md` §3/C6: YAML was settled as JSON, and this
repository has no YAML parser on purpose).

To regenerate after a change in `OnTrak-dev` (which stays untouched):

```sh
python3 - <<'PY'
import json, shutil
from pathlib import Path
import yaml
lab, out = Path("OnTrak-dev/scenarios"), Path("scenarios")
for name in ("OnTrak.Common.ps1", "ontrak-common.sh", "idp.py"):
    shutil.copy2(lab / "_lib" / name, out / "_lib" / name)
for d in sorted(p for p in lab.iterdir() if p.is_dir() and p.name != "_lib"):
    target = out / d.name
    target.mkdir(exist_ok=True)
    for script in ("setup.ps1", "setup.sh", "check.ps1", "check.sh"):
        if (d / script).exists():
            shutil.copy2(d / script, target / script)
    (target / "scenario.json").write_text(
        json.dumps(yaml.safe_load((d / "scenario.yaml").read_text()), indent=2, ensure_ascii=False) + "\n"
    )
PY
```

`tests/lab-dataset.test.ts` asserts the tree is complete — all 14 records, and the script
each scenario's platform actually runs — because a missing `check.sh` is otherwise found by
a student whose work cannot be graded.
