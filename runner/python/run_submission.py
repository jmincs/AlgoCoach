import contextlib
import io
import sys
import time
import traceback
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import orjson


@dataclass
class SubmissionPayload:
    language: str
    code: str
    function_name: str
    tests: List[Dict[str, Any]]
    timeout_ms: int
    reference_code: Optional[str]

    @classmethod
    def from_json(cls, raw: bytes) -> "SubmissionPayload":
        try:
            data = orjson.loads(raw)
        except orjson.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON payload: {exc}") from exc

        language = data.get("language", "python").lower()
        if language != "python":
            raise ValueError(f"Unsupported language '{language}'. Only python is available in this sandbox.")

        code = data.get("code")
        if not isinstance(code, str) or not code.strip():
            raise ValueError("Field 'code' must be a non-empty string.")

        function_name = data.get("functionName") or data.get("function_name")
        if not isinstance(function_name, str) or not function_name.strip():
            raise ValueError("Field 'functionName' must be a non-empty string.")

        tests = data.get("tests", [])
        if not isinstance(tests, list):
            raise ValueError("Field 'tests' must be a list.")

        timeout_ms = data.get("timeoutMs", 2000)
        if not isinstance(timeout_ms, int) or timeout_ms <= 0:
            raise ValueError("Field 'timeoutMs' must be a positive integer.")

        reference_code = data.get("referenceCode")
        if reference_code is not None and not isinstance(reference_code, str):
            raise ValueError("Field 'referenceCode' must be a string when provided.")

        return cls(
            language=language,
            code=code,
            function_name=function_name,
            tests=tests,
            timeout_ms=timeout_ms,
            reference_code=reference_code,
        )


def encode(obj: Any) -> bytes:
    return orjson.dumps(obj)


def failure(message: str, *, details: Optional[str] = None) -> bytes:
    payload = {"status": "error", "message": message}
    if details:
        payload["details"] = details
    return encode(payload)


def load_callable(payload: SubmissionPayload):
    env: Dict[str, Any] = {}
    try:
        exec(compile(payload.code, "<submission>", "exec"), env, env)
    except Exception:
        raise RuntimeError(traceback.format_exc())

    fn = None

    if "Solution" in env:
        try:
            instance = env["Solution"]()
            fn = getattr(instance, payload.function_name, None)
        except Exception:
            raise RuntimeError("Failed to instantiate Solution:\n" + traceback.format_exc())
    else:
        fn = env.get(payload.function_name)

    if fn is None or not callable(fn):
        raise RuntimeError(
            f"Unable to locate callable '{payload.function_name}'. "
            "Define it either as a free function or as a method on class Solution."
        )

    ref_fn = None
    if payload.reference_code:
        ref_env: Dict[str, Any] = {}
        try:
            exec(compile(payload.reference_code, "<reference>", "exec"), ref_env, ref_env)
        except Exception:
            raise RuntimeError("Failed to load reference solution:\n" + traceback.format_exc())

        if "Solution" in ref_env:
            try:
                inst = ref_env["Solution"]()
                ref_fn = getattr(inst, payload.function_name, None)
            except Exception:
                raise RuntimeError("Reference Solution instantiation failed:\n" + traceback.format_exc())
        else:
            ref_fn = ref_env.get(payload.function_name)

        if ref_fn is None or not callable(ref_fn):
            raise RuntimeError(f"Reference solution missing callable '{payload.function_name}'.")

    return fn, ref_fn


def run_tests(fn, ref_fn, payload: SubmissionPayload):
    results = []
    start = time.perf_counter()
    timeout_seconds = payload.timeout_ms / 1000.0

    for test in payload.tests:
        name = test.get("name") or "case"
        args = test.get("args", [])
        expect = test.get("expect")

        if (time.perf_counter() - start) > timeout_seconds:
            results.append(
                {
                    "name": name,
                    "pass": False,
                    "timeout": True,
                    "stdout": "",
                    "stderr": "",
                    "error": f"Timed out after {payload.timeout_ms} ms",
                }
            )
            break

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        case_start = time.perf_counter()
        try:
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                result = fn(*args if isinstance(args, list) else args)
            case_error = None
        except Exception:
            case_error = traceback.format_exc()
            result = None

        stdout_content = stdout_buf.getvalue()
        stderr_content = stderr_buf.getvalue()
        elapsed = (time.perf_counter() - case_start) * 1000.0

        reference_stdout = ""
        reference_stderr = ""
        reference_error = None
        reference_result = None
        if ref_fn is not None:
            ref_stdout_buf = io.StringIO()
            ref_stderr_buf = io.StringIO()
            try:
                with contextlib.redirect_stdout(ref_stdout_buf), contextlib.redirect_stderr(ref_stderr_buf):
                    reference_result = ref_fn(*args if isinstance(args, list) else args)
            except Exception:
                reference_error = traceback.format_exc()
            reference_stdout = ref_stdout_buf.getvalue()
            reference_stderr = ref_stderr_buf.getvalue()

        if expect is None and reference_error is None:
            expect = reference_result

        if case_error:
            outcome = {
                "name": name,
                "pass": False,
                "error": case_error,
                "stdout": stdout_content,
                "stderr": stderr_content,
                "elapsedMs": round(elapsed, 3),
                "referenceResult": reference_result,
                "referenceError": reference_error,
                "referenceStdout": reference_stdout,
                "referenceStderr": reference_stderr,
            }
        else:
            passed = result == expect if reference_error is None else False
            outcome = {
                "name": name,
                "pass": bool(passed),
                "got": result,
                "expect": expect,
                "stdout": stdout_content,
                "stderr": stderr_content,
                "elapsedMs": round(elapsed, 3),
                "referenceResult": reference_result,
                "referenceError": reference_error,
                "referenceStdout": reference_stdout,
                "referenceStderr": reference_stderr,
            }

        results.append(outcome)

    total_elapsed = (time.perf_counter() - start) * 1000.0
    status = "ok"
    if any(not case.get("pass") for case in results):
        status = "failed"
    if any(case.get("timeout") for case in results):
        status = "timeout"

    return {
        "status": status,
        "results": results,
        "timeMs": round(total_elapsed, 3),
    }


def main():
    raw = sys.stdin.buffer.read()
    if not raw:
        sys.stdout.buffer.write(failure("Empty payload"))
        return

    try:
        payload = SubmissionPayload.from_json(raw)
    except ValueError as exc:
        sys.stdout.buffer.write(failure("Bad request", details=str(exc)))
        return

    try:
        callable_fn, reference_fn = load_callable(payload)
    except RuntimeError as exc:
        sys.stdout.buffer.write(failure("Compilation error", details=str(exc)))
        return

    try:
        response = run_tests(callable_fn, reference_fn, payload)
    except Exception:
        sys.stdout.buffer.write(failure("Internal runner error", details=traceback.format_exc()))
        return

    sys.stdout.buffer.write(encode(response))


if __name__ == "__main__":
    main()

