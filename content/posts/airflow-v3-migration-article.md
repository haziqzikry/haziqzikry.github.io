---
title: What migrating to Airflow 3 actually looks like in production
date: 2026-05-18
tags: [airflow, data-engineering, python]
image: /images/posts/airflow-v3/airflow-parallel-run.svg
draft: false
---

Don't you just love getting paged at 2am on a random Saturday (read: **WEEKEND**) because critical data and reports weren't ready on time? Yeah, I love my job. You trace it back through many layers of infrastructure:

1. A Spark job that timed out/crashed/OOM.
2. A staging table that's stale.
3. A consumable pipeline that never triggered.

Somewhere in that chain, you lose an hour you didn't have to find the root cause, look into similar incident reports, rerun and debug, and then finally get a fix that can be implemented temporarily till the following morning (oh, and don't forget to write the post-mortem incident report too). You really start questioning every life decision that led you to data engineering at this point (**exaggerated** as it is part of the job, but it did feel like that sometimes la).

That was the reality of running a typical [**3-layer medallion architecture data lake**](https://www.databricks.com/blog/what-is-medallion-architecture) with my previous employer. We orchestrated data pipelines on an infrastructure that processes millions of payment transactions daily. The data had to be accurate, available on time, and fast to recover. Reports that had hard SLAs and downstream systems depended on final data being ready within specific time windows. Every extra layer between source ingestion and the final output was another failure point for delays to accumulate...and another place for me and other engineers to lose sleep over.

![](/images/posts/airflow-v3/airflow-intro-meme.png)
*Wow! Airflow for data orchestration! [Link to meme](https://www.tiktok.com/@mrizkidata/video/7568847374055918855?is_from_webapp=1&sender_device=pc&web_id=7640870573282919937)*

[**Apache Airflow**](https://github.com/apache/airflow) was the backbone of that orchestration. At its peak, the product I started the migration on (which had the highest-volume in the lake) had **~50 active DAGs** on our [EKS](https://aws.amazon.com/eks/) environment. That might not seem a lot to many of you data engineers out there but it was considered a lot, relative to our other pipelines. And in late 2025, I started a migration that turned out to be two problems at once: a shift from a 3-layer to a 2-layer data architecture, and **an upgrade from Airflow 2 to Airflow 3**. Airflow 3 was announced way back in [April 2025](https://airflow.apache.org/blog/airflow-three-point-oh-is-here/) as a **major release** but my team and I did not really look into it much since we had other priorities to handle...till this became our priority.

The discovery, infrastructure setup, initial POCs, and the first pipelines to production were all done **under 2 months**. My team leads and fellow data engineers were incredibly encouraging throughout. Chiming in with new ideas, catching things I missed, and iterating on the architecture alongside me. Without them, this would have taken much longer and probably broken a lot more things.

This article is that story. I'm writing it the way I wish someone had written it for me before I started (including the embarrassing parts). 

Get your kopi ais ready folks, it's somewhat a long one (or you can just skip to the parts that interest you based on the TOC).

---

## 1. Wait...we have to migrate **this** too??

> **TLDR - we had an architecture problem too..**
>
> **The problem:** 3-layer data lake. Airflow 2 DAGs for ingestion, Airflow 2 + Spark/EMR for transformation (ETL), another Airflow 2 ETL for the consumable layer. Expensive EMR clusters for jobs Athena could handle in seconds, additive SLA delays across every layer, and three things to version, test, and debug for every pipeline.
>
> So how tf are we gonna fix this??
>
> **The fix:** Collapse raw and staging into **one layer** and keeping it as a 2-layer data lake. Transformation logic applied at ingestion time. Parquet written directly to S3, schema enforced, registered in Glue. Athena can query it the moment ingestion finishes. Airflow 3 now only manages the consumable layer: Athena queries → Iceberg writes via PyIceberg. No Spark in the critical path and still fits the use case perfectly.

The architecture change made the Airflow migration easier to reason about, but it also doubled the scope. Every breaking change in Airflow 3 had to be solved while simultaneously rethinking which DAGs even needed to exist. The rest of this article is about what the Airflow 3 migration actually required and what I faced during the process.

---

## 2. Surely it can't be that difficult to migrate...

![](/images/posts/airflow-v3/airflow3-migration-meme.png)
*yeah i was kinda wrong about this...*

Before getting into the specific breaking changes, it is worth understanding _why_ so many things broke. Because when I first hit these errors, I thought I was doing something wrong. I was not. Airflow 3 is genuinely, intentionally different under the hood in ways that invalidate a lot of patterns that worked perfectly fine in Airflow 2.

### The Airflow 2.x EOL situation

![](/images/posts/airflow-v3/airflow2-eol.png)
*Airflow 2.x EOL announcement — [astronomer.io/airflow-2-eol](https://www.astronomer.io/airflow-2-eol/)*

Open-source Apache Airflow 2.x officially reached **end of life** on **April 22, 2026** (rip). No more security patches, bug fixes, or provider package updates. Your DAGs don't suddenly stop running, but the risk compounds quietly: dependencies drift, provider packages start requiring Airflow 3, and you end up maintaining a frozen environment with no upstream help. It wasn't the primary reason we migrated, but "unpatched CVEs on a payment platform" is not a conversation you want to have with your security team. We were already planning the migration for architectural reasons but the EOL date just added urgency.

![](/images/posts/airflow-v3/airflow-version-lifecycle.png)
*Apache Airflow version lifecycle — [github.com/apache/airflow](https://github.com/apache/airflow#version-life-cycle)*

### Airflow 2.x: everything talks to the database directly

In Airflow 2, every component (the scheduler, the webserver, the workers) communicated directly with the metadata database (typically PostgreSQL - RDS Aurora on EKS). When a worker executed a task, it opened its own database connection, read state from it, wrote XCom values to it, and could in principle reach into any table in the metadata DB it fancied. Task code ran in the same process as the worker, with no separation whatsoever between your code and Airflow's internals.

![](/images/posts/airflow-v3/airflow2-arch.png)
*Airflow 2.x: every component connects directly to the metadata database — [Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html)*

### Airflow 3.x: a proper client-server model

Airflow 3 introduces the Task Execution Interface — the most significant architectural shift in Airflow's history. The core idea is simple but the implications are wide: **tasks no longer talk to the database directly.** An API Server becomes the single gatekeeper to the metadata database. Workers talk to the API Server. Your task code talks to the Task SDK. Nothing gets direct DB access anymore.

![](/images/posts/airflow-v3/airflow3-arch.png)
*Airflow 3.x: the API Server is the sole gatekeeper — [Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html)*

The practical consequences, which I discovered the hard way:

**Task isolation.** Task code can no longer import and use Airflow's internal ORM or database sessions. If your DAG or any shared library tries to open a database session at runtime, you will immediately hit `RuntimeError: Direct database access via the ORM is not allowed in Airflow 3.0`. There is no graceful degradation. It just explodes with a RuntimeError and you spend the next hour figuring out which library buried deep in your shared code is trying to touch the database.

For `KubernetesExecutor` specifically, the change meant worker pods no longer run persistent worker processes. In Airflow 2, a worker pod would stay alive and handle multiple tasks. In Airflow 3, the `KubernetesExecutor` injects task execution commands into ephemeral pods that run one task and terminate. **The old `airflow worker` command from Airflow 2 is completely removed.**

### Other things that actually improved

- **React UI**: fully rewritten, genuinely much nicer than the old Flask AppBuilder interface, and not just cosmetically.
- **DAG Versioning**: finally. In Airflow 2, deploying a new DAG version mid-run could produce a confused mix of old and new task structure. In Airflow 3, a run executes against the version it started with, all the way through to completion. One less thing to pray about during rolling deployments.
- **REST API**: moved from `/api/v1` (Flask) to `/api/v2` (FastAPI). Noticeably faster, with proper OpenAPI documentation.
- **Backfills**: now properly scheduler-managed. You can trigger and monitor backfills from the UI or API instead of the CLI, with real-time progress visibility. The scheduler handles execution directly, which means better control and diagnostics when something goes wrong mid-backfill.

---

## 3. Airflow 2 vs 3: the code-level changes

Now the part where you find out how many files you need to touch. The answer is: all of them.

### Import paths

The new public interface for DAG authoring is `airflow.sdk`. Everything from `airflow.models`, `airflow.decorators`, `airflow.utils`, and the various internal paths needs to move. Example changes:

| Old (Airflow 2)                                       | New (Airflow 3)                              |
| ----------------------------------------------------- | -------------------------------------------- |
| `from airflow.models import DAG`                      | `from airflow.sdk import DAG`                |
| `from airflow.decorators import task`                 | `from airflow.sdk import task`               |
| `from airflow.decorators import task_group`           | `from airflow.sdk import task_group`         |
| `from airflow.models.variable import Variable`        | `from airflow.sdk import Variable`           |

Operators that were previously bundled in `airflow-core` have also been split into `apache-airflow-providers-standard`:

```python
# Old
from airflow.operators.dummy import DummyOperator
from airflow.sensors.date_time import DateTimeSensor

# New
from airflow.providers.standard.operators.empty import EmptyOperator
from airflow.providers.standard.sensors.date_time import DateTimeSensor
```

The good news is you don't have to find all of this manually. The Ruff linter has Airflow-specific rules that catch most of it and can even fix it automatically:

```bash
ruff check dags/ --select AIR301 --show-fixes
ruff check dags/ --select AIR301 --fix
```

Run that first before you do anything else. It won't catch everything but it's a great starting point.

Other deprecations that may or may not bite you:

| Airflow 2           | Airflow 3                  |
| ------------------- | -------------------------- |
| `schedule_interval` | `schedule`                 |
| `concurrency`       | `max_active_tasks`         |
| `provide_context`   | *(removed — now built in)* |
| `apply_defaults`    | *(removed — now built in)* |

---

## 4. Running V2 and V3 in parallel

One question that comes up immediately when you plan a migration like this: how do you run the old pipelines and the new ones at the same time without breaking each other? The answer is not "carefully" but the answer is **isolation and running in parallel.**

![](/images/posts/airflow-v3/airflow-parallel-run.svg)
*Rough sketch on how Airflow 2 and 3 ran in parallel*

We ran **two entirely separate Airflow deployments** for Airflow 2 and 3. Separate S3 DAG buckets, and separate shared libraries for V2 and V3. The two sets of pipelines had zero shared state. Airflow 2 DAGs kept running against the old 3-layer architecture while Airflow 3 DAGs were built, tested, and promoted product by product using the new 2-layer architecture. If V3 go kaboom and kablow, V2 was completely unaffected.

The provisioning infrastructure was also extended: new Terraform modules pointing to V3-specific paths in the infrastructure repo, new Airflow deployments for the V3 environments, and new V3 dev branches for the engineers to work on and provision. It sounds more complicated than it was but actually in practice it mostly came down to naming things consistently and pointing to the right paths.

This separation meant we could experiment freely without the constant anxiety of "what if this breaks production" and could decommission V2 comfortably once all the DAGs are migrated. That process is still ongoing for some products, but the pattern holds. Double cost for now, but hey that's the price you pay for a steady migration (or not idk).

---

## 5. War stories: some of the gotchas I hit during discovery

This is the section I wish had existed before I started. Real errors, real dates, real "wtf why is this happening??" moments from my notes. I'm putting them here so you don't have to rediscover them at midnight.

> **Note:** A note on versions: we ran initial discovery on Airflow **3.0.6**, moved active testing to **3.1.5,** and are currently (i think) on **3.1.8** in production.

### Why do I need to deal with the `executor_config` ??

On my early discoveries with Airflow 3.x, I hit this on the very first real DAG test in our dev environment which I only found in the scheduler logs:

```
[kubernetes_executor.py:273] ERROR - Invalid executor_config for
TaskInstanceKey(dag_id='redacted',
task_id='define_on_demand_job_arg', ...).
Executor_config: {'KubernetesExecutor': {'request_cpu': '500m',
'limit_cpu': '1000m', 'request_memory': '2Gi', 'limit_memory': '4Gi'}}
```

The task never started. No helpful error in the DAG logs and the DAG will just get stuck forever. We had `executor_config` set in `default_args` which is a completely standard Airflow 2 pattern for specifying CPU and memory limits at the DAG level. Turns out it silently does nothing at the `default_args` level in Airflow 3. **The configuration is accepted, parsed, and then ignored.**

What made this particularly hard to diagnose: when `executor_config` is misconfigured at the DAG level, the scheduler does not throw an error. Instead it quietly falls back to `CeleryExecutor` for that task. A Celery worker pod spins up instead of a Kubernetes task pod. The task sits in queue indefinitely. You sit there refreshing the Airflow UI wondering if something is broken or if you just need to wait longer.

**The tell is in the pod labels.** If you see `component=worker` on the pod but no `kubernetes_executor=True` label, your task ended up on Celery. That is the first thing to check.

After way too long digging through GitHub issues, the fix was moving `executor_config` to each individual `@task` decorator:

```python
# create_eks_ondemand_override is a shared library used with kubernetes.client.models.V1Pod to do pod override
k8s_exec_config = {
    'pod_override': create_eks_ondemand_override(
        annotations={'airflow-data-product': 'my-product'},
        high_priority=True,
    )
}

@task(
    trigger_rule='none_failed_min_one_success',
    executor_config=k8s_exec_config
)
def parse_job_param(**context):
    ...
```

Also worth noting: the dict-style `executor_config` is deprecated in Airflow 3. Use `kubernetes.client.models.V1Pod` with a `pod_override` key as shown above.

This bug was still present as of Airflow 3.1.8 (our current production version). Before assuming it's been resolved in your version, check the open GitHub issues for `KubernetesExecutor` but the workaround above applies regardless.

### `create_or_update_pool` and the ORM wall

We used `create_or_update_pool` in a few DAGs to dynamically manage Airflow pool slots at startup. In Airflow 3, the moment that code runs, you get:

```
RuntimeError: Direct database access via the ORM is not allowed in Airflow 3.0
```

No partial success, no graceful fallback. The task just dies. This is exactly the Task SDK wall from Section 2 showing up in practice. The fix: use the new REST API (`/api/v2`) to create and update pools from outside the DAG context or don't use pools at all (which for our case, we removed it entirely).

### Scheduling is different now (but why)

This one does not throw an error. Your DAG runs, it succeeds, and you only find out something is wrong when you look at the data. *Wait, why tf is this table empty?*

I ran a refactored DAG in dev. Completed successfully. Went to check the output Iceberg table. Empty. ??

Checked the SQL, lgtm. Ran it manually in Athena, got data. Checked the DAG logs, no errors. Checked the Iceberg table. Definitely empty.

It took embarrassingly long to figure out: both `data_interval_start` and `data_interval_end` were pointing to the same timestamp, so `WHERE date >= start AND date < end` was filtering out literally everything. **The window was zero seconds wide.**

Here's what actually changed between AF2 and AF3:

|                           | Airflow 2                                   | Airflow 3                            |
| ------------------------- | ------------------------------------------- | ------------------------------------ |
| First run                 | Wait one full interval after `start_date`   | Starts immediately at `start_date`   |
| `data_interval_start/end` | Separate, defines a real time window        | Collapsed, both equal `logical_date` |
| Recommended variable      | `data_interval_start` / `data_interval_end` | `logical_date`                       |

So a `@daily` DAG starting `2025-01-01` now looks like this:

| Run | Starts at | `logical_date` covers |
|---|---|---|
| DAG Run 1 | 2025-01-01 00:00 | 2025-01-01 → 2025-01-02 |
| DAG Run 2 | 2025-01-02 00:00 | 2025-01-02 → 2025-01-03 |

```python
# What we had — looks fine, worked in Airflow 2
start = context['data_interval_start']  # e.g. 2025-12-09 00:00
end = context['data_interval_end']      # e.g. 2025-12-10 00:00

query = f"""
    SELECT * FROM raw_db.trxn_tbl
    WHERE date >= '{start.date()}' AND date < '{end.date()}'
"""

# In Airflow 3 without CronDataIntervalTimetable:
# start == end == logical_date → zero-width window → empty result → silent
```

Given our strict SLA requirements, this could've been an operational nightmare if we hadn't caught it in dev. At least a crash alerts someone because an empty report is not really ideal (well it depends sometimes but you get the gist of it).

**The fix:** use `CronDataIntervalTimetable`, which restores Airflow 2 interval behaviour:

```python
from airflow.timetables.interval import CronDataIntervalTimetable

@dag(
    schedule=CronDataIntervalTimetable(
        cron="0 0 * * *",
        timezone="Asia/Kuala_Lumpur"
    ),
    ...
)
def my_dag():
    ...
```

Or set `AIRFLOW__SCHEDULER__CREATE_CRON_DATA_INTERVALS=True` in your Airflow env. Either way, **put this on your migration checklist and make it non-negotiable.** We added it to ours so nobody else had to experience the "why is my table empty" moment.

---

## 6. Our shared libraries were f****d too

When I was 'in the zone' of doing discovery for Airflow 3, I soon realized that I had to refactor and rebuild the **ENTIRE** shared library that we had for Airflow (FML). "Rebuilt from scratch" is not an exaggeration btw because there were too many breaking changes in some of the important libraries that we use. So, I took the opportunity to remove everything that wasn't being used in production (there was more of that than anyone wanted to admit), merge redundant utilities into their correct homes, and organize things so that a new engineer could read the directory tree and understand where to look.

The structure ended up looking something like below, but your library will look different depending on your stack; the `processor/` layer is the meaningful new addition as it is the glue between Athena, Polars, and PyIceberg that the rest of the article describes:

```
shared-library-v3/
└── libraries/
    ├── dag_helper.py              # Kubernetes pod overrides for Airflow v3
    ├── s3_helper.py               # S3 operations
    ├── api_helper.py              # Airflow REST API interactions
    ├── aws.py                     # AWS service clients (S3, DynamoDB, Secrets Manager)
    ├── ssh_helper.py              # SSH/SFTP file transfer
    ├── alert.py                   # Alerting callbacks (on_failure_callback)
    ├── logging_helper.py          # Structured JSON logging
    ├── dt_helper/                 # Date/time utilities
    ├── sql_helper/                # Athena query helpers (IRSA-based)
    └── processor/                 # Core ETL processors
        ├── athena_helper.py       # Athena UNLOAD utilities
        ├── loader.py              # IcebergLoader (Polars -> PyArrow -> PyIceberg)
        ├── reader.py              # S3 Parquet reader (Polars)
        └── transformer.py        # Data transformation utilities
```

The migration made all the accumulated debt visible all at once. I cleaned it up while I had the chance and the motivation (and sanity). Future engineers navigating this codebase will hopefully never know what it used to look like. Engineers are expected to extend it as they migrate their own pipelines, iterating in the process.

### The new ETL stack: Polars, PyArrow, and PyIceberg

With Spark and EMR gone from the critical path, we needed a new way to load data into Iceberg tables. The answer was a **pure Python pipeline**: Polars for reading and light transformation, PyArrow for schema casting, and PyIceberg for writing to Glue Iceberg tables directly.

The high-level flow for every ETL DAG:

```
pre-ETL setup
    → Athena UNLOAD  (query ingestion layer, write Parquet to S3 temp path)
    → Polars read    (read Parquet from S3 temp — no schema enforcement yet)
    → PyArrow cast   (enforce schema from data_contract.py)
    → PyIceberg write  (load to Glue Iceberg table)
    → end
```

The UNLOAD step queries the ingestion layer and writes Parquet to a temp S3 path. The `.sql` file contains only the `SELECT` and the `UNLOAD` wrapper is built in the DAG so queries stay reusable outside of Airflow context.

Each product/table defines its table schema in a `data_contract.py` file which is **the** single source of truth for schema and partitioning, replacing a messier pattern where schema lived in two places and could silently drift out of sync:

```python
from pyiceberg.schema import Schema
from pyiceberg.types import NestedField, StringType, LongType, TimestampType
from pyiceberg.partitioning import PartitionSpec, PartitionField
from pyiceberg.transforms import IdentityTransform

tbl_xx_schema = {
    'schema': Schema(
        NestedField(1, 'trxn_id', StringType(), required=True),
        NestedField(2, 'amount', LongType(), required=False),
        NestedField(3, 'trxn_date', TimestampType(), required=False),
        NestedField(4, 'year_month', StringType(), required=False),
        NestedField(5, 'etl_timestamp', TimestampType(), required=False)
    ),
    'partition_spec': PartitionSpec(
        PartitionField(source_id=4, field_id=1000,
                       transform=IdentityTransform(), name='year_month')
    ),
    'properties': {'write.parquet.compression-codec': 'snappy'}
}
```

---

## 7. Trade-offs and what's still unresolved

Of course, not everything was perfect. I had a couple of bumps that I may or may not have solved while I was still employed there...

**Data accuracy during merges.** The `overwrite` mode in `IcebergLoader` does a merge-then-replace of the entire table with deduplication on merge keys. I tested this thoroughly in development, but data loss edge cases during high-volume merges have not been fully characterized at production scale. `insert_overwrite` is safer for append-heavy patterns. The right mode genuinely depends on each pipeline's semantics, and we are still figuring out the right defaults per use case.

**Schema handling.** There is an ongoing internal debate about where schema should live: in `data_contract.py` with explicit PyIceberg types (current approach), or defined entirely in the Athena SQL and enforced through `UNLOAD` output. Both work. Both have advocates. This will probably evolve as more pipelines migrate and we learn which approach causes fewer headaches in practice.

There are probably more things that I have not discovered that hopefully all my other talented engineers got the bingo moment and reiterate on their own.

---

## 8. Reflections

There are probably many takeaways from this migration, but the one I'd most want to pass on to other engineers is to **always write and document things as you go.**

Originally, I just made internal notes/docs to stop myself from forgetting what I'd broken (I literally wrote down every single detail because I WILL forget something even if I discovered a bug 30 mins prior). I ended up polishing those docs and it _somehow_ became **the onboarding material for the entire team** to migrate to Airflow 3. Your future teammates will thank you, and so will future-you when you have to explain a decision you made at 2am on a random Wednesday in December (fun times indeed).

None of this came from one person having brilliant ideas in a room. My leaders **challenged assumptions and pushed back on early design decisions** in ways that made things genuinely better. They created space for me to iterate without pressure to lock things in early. Other DEs migrating their own pipelines **found edge cases I'd completely missed** and contributed fixes back to the shared library and overall architecture. That back-and-forth is what turned a rough POC into something that **actually holds up in production** and I'm super grateful for every one of them.

Was it worth it tho? **~50 DAGs to ~20** (mostly due to the 2-layer architecture). **No EMR in the critical path.** SLAs that are actually achievable. Transactional data available the moment ingestion finishes. All in all, sounds good to me. Pioneering an architecture design that _hopefully_ makes all the other DEs happier is always a plus as well (unless they refactor everything again but hey that's for another story to tell...).

![](/images/posts/airflow-v3/airflow-outro-meme.png)
*Meme creds to this author — [Apache Airflow : 10 Rules to Make It Work ( scale )](https://medium.com/data-science/apache-airflow-in-2022-10-rules-to-make-it-work-b5ed130a51ad)*
