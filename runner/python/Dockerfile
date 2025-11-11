# Python sandbox image for remote judge prototype
#
# This image is intentionally minimal: it installs Python, copies the harness
# script, and configures the container to read the submission JSON from STDIN.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /judge

COPY requirements.txt /judge/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY run_submission.py /judge/run_submission.py

ENTRYPOINT ["python", "/judge/run_submission.py"]

