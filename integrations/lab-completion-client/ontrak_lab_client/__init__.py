"""The lab's half of the OnTrak completion boundary.

Report a finished session on a real machine to the family, which records it as a
graded attempt with ``gradingMode = 'lab'``. See README.md in the directory above
for install and usage, and ``docs/lab-completion.md`` in the repository root for
the contract itself.
"""

from .client import (
    API_TOKEN_ENV,
    BASE_URL_ENV,
    COMPLETION_ROUTE,
    LAB_COMPLETION_FORMAT,
    LabCheck,
    LabCompletion,
    LabCompletionClient,
    LabCompletionError,
    LabCompletionInvalid,
    LabCompletionRefused,
    LabCompletionResult,
    LabCompletionUnavailable,
    report_completion,
)

__all__ = [
    "API_TOKEN_ENV",
    "BASE_URL_ENV",
    "COMPLETION_ROUTE",
    "LAB_COMPLETION_FORMAT",
    "LabCheck",
    "LabCompletion",
    "LabCompletionClient",
    "LabCompletionError",
    "LabCompletionInvalid",
    "LabCompletionRefused",
    "LabCompletionResult",
    "LabCompletionUnavailable",
    "report_completion",
]
