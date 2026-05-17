---
title: What Migrating to Airflow 3 ACTUALLY Looks Like in Production
date: 2026-05-16
tags:
  - airflow
  - data-engineering
  - migration
---
# What Migrating to Airflow 3 ACTUALLY Looks Like in Production

There's a particular kind of dread that comes with opening the Airflow UI at 2am because critical data hasn't landed. You trace it back through 3 layers of infrastructure:

1. A Spark job that timed out/crashed/OOM.
2. A staging table that's stale.
3. A consumable pipeline that never triggered.
    
Somewhere in that chain, you lose an hour you didn't have and you really start questioning every life decision that led you to data engineering (exaggerated but it did feel like that sometimes la).

That was the reality of running a **typical 3-layer medallion architecture data lake** with my previous employer. We orchestrated data pipelines on an infrastructure that processes millions of payment transactions daily. The data had to be accurate, available on time, and fast to recover. 
Reports that had hard SLAs and downstream systems depended on consumable data being ready within specific time windows. Every extra layer between source ingestion and the final output was another failure point for delays to accumulate....and another place for me and other engineers to lose sleep over.

**Apache Airflow** was the backbone of that orchestration. At its peak, the product I started the migration on (which had the highest-volume in the lake) had **~50 active DAGs**. That might not seem a lot to many of you data engineers out there but it was considered a lot, relative to our other pipelines. And in late 2025, I started a migration that turned out to be two problems at once: a shift from a 3-layer to a 2-layer data architecture, and **an upgrade from Airflow 2 to Airflow 3**. The discovery, infrastructure setup, initial POCs, and the first pipelines to production were all done **under 2 months**. My team leads, and fellow data engineers were incredibly encouraging throughout. Chiming in with new ideas, catching things I missed, and iterating on the architecture alongside me. Without them this would have taken much longer and probably broken a lot more things.

This article is that story. I'm writing it the way I wish someone had written it for me before I started (including the embarrassing parts).

---

## 1. The old architecture: 3 layers, 1 big problem

Our data lake followed a classic 3-layer model. Airflow 2 DAGs were responsible for ingestion: pulling data from source databases and writing raw Parquet files to S3. From there, Spark/EMR jobs ran transformations and wrote results into structured Iceberg tables. Finally, another set of Airflow ETL pipelines processed those staging tables into the consumable layer that downstream reporting systems could query.

> **[Diagram: 3-layer vs 2-layer architecture — see published article]**

On paper this is a reasonable separation of concerns. In practice it was painful in three ways.

**Cost.** EMR clusters are expensive. Increasing our nodepool size to run transformations touching a few hundred thousand rows which Athena could do the same query in seconds and for much lesser cost — felt like hiring a bulldozer to plant a flower. The more pipelines we added, the more EMR usage grew.

**SLA pressure, which was the more urgent problem.** Our reporting pipelines had strict delivery windows. In a 3-layer architecture, the time from source to consumable is additive: ingestion DAG runtime, plus Spark cluster startup and transformation job runtime, plus consumable pipeline runtime. Each layer compounded the delay. When things ran smoothly it was manageable. When anything slipped, the SLA was at risk. And recovery was the worst part: a failed Spark job meant rerunning it, waiting for the cluster to spin back up, waiting for the job to finish, then rerunning the downstream pipeline. For a company where reporting accuracy is non-negotiable, that cascading failure was a liability we could not keep accepting.

**Maintenance burden.** Three layers meant three things to version, test, monitor, and debug. Every business logic change potentially touched all three. It's the kind of setup where you fix one thing and accidentally break two others. This is data engineering in a nutshell.

The insight that changed things came from looking at what our in-house custom ingestion tool was already capable of. It had been extended with plugins that could apply transformation logic at write time. If the data coming out of the tool already had the right derived fields, the correct schema, and enforced types, why were we still relying on dedicated Spark layer on top of it?

Spoiler: we didn't need to.

---

## 2. The new architecture only has 2 layers

The answer was to collapse the raw and staging layers into one, and keeping our consumable (gold) layer as the final real output.

The key shift was replacing Airflow ingestion DAGs with the batch exporter for all data movement from source to S3. The batch exporter is not a generic off-the-shelf tool — it is a custom in-house system we extended specifically for this migration. Its v3 mappers reverse-engineer the Spark transformation logic and apply it at ingestion time, writing Parquet directly to S3 in a Hive-compatible directory structure (meaning the files are laid out in dated partitions that Glue and Athena can read directly without any additional processing), with derived fields computed, data types enforced, and the schema registered in AWS Glue as a Hive table with partition projection enabled.

The result: Athena can query this data the moment the exporter finishes writing. There is no staging step, no transformation job to wait on, no "quick coffee while Spark starts up" moment. We did not remove the transformation logic — we moved it upstream to the ingestion layer and eliminated the dedicated transformation infrastructure that had been sitting between ingestion and consumption, quietly burning money.

Airflow 3 now only handles the consumable layer: running Athena queries against the ingestion layer output and writing results into Apache Iceberg tables via PyIceberg. If you haven't used Iceberg before: it's an open table format for large analytic datasets that sits on top of Parquet files in S3, adding proper ACID transactions, schema evolution, time travel, and partition pruning — essentially giving you warehouse-grade table semantics on top of an object store. No EMR, no PySpark anywhere in the critical path.

This is what made the SLA story much cleaner. Instead of: ingest → wait for Spark → wait for consumable pipeline → pray — it became: ingest (transforms already done), run Athena query, write to Iceberg, done. The time between "data landed" and "data is ready for downstream" dropped significantly, and recovery when things broke became minutes rather than a cascading multi-step disaster.

The new tables follow an updated partition path:

```
# Old path (Airflow 2 / v1)
s3:/{product}-raw/parquet_v1/year=2025/month=12/day=10/hour=09/minute=45/

# New path (custom ingestion tool, partition projection compatible)
s3://{product}-raw/parquet_v3/date=2025-12-10/hour=09/minute=45/
```

The year/month/day breakdown is gone, replaced by a single `date` partition. Cleaner, fewer columns to manage in Glue, and plays nicely with partition projection.

**A quick word on partition projection:** Traditional Hive partitioning requires Athena to call the Glue API to list every partition before it can plan a query. On a large table with thousands of date/hour partitions, that listing step alone adds meaningful latency — and at our data volumes, it was noticeable. Partition projection tells Glue to compute the partition locations mathematically from the query's `WHERE` clause instead of listing them, which makes query startup dramatically faster. The trade-off is that every query _must_ include a `WHERE` clause on the partition columns (`date`, `hour`). A `SELECT *` without a partition filter is basically telling Athena to scan the entire universe. We had to instil this discipline across the team — not everyone was thrilled about it at first, but it became second nature quickly.

The impact on DAG count was measurable before the migration was even complete: the first product we migrated went from ~50 DAGs to a target of 24, removing all the on-demand, scheduled, and end-to-end workflow DAGs that existed purely to manage the Spark transformation layer, plus hourly workflows made redundant by partition projection. 50 DAGs to 24. Not bad for a few months of work.

---

## 3. Running V2 and V3 side by side

One question that comes up immediately when you plan a migration like this: how do you run the old pipelines and the new ones at the same time without breaking each other? The answer is not "carefully" — the answer is isolation. Total, paranoid isolation.

We ran two entirely separate Airflow deployments on EKS: separate provisioners, separate S3 DAG buckets, and separate shared libraries — `sharedlib-airflow` (on `master`) for V2, and `sharedlib-airflow-v3` (on a new protected `v3-master` branch) for V3. The two sets of pipelines had zero shared state. Airflow 2 DAGs kept running against the old 3-layer architecture while Airflow 3 DAGs were built, tested, and promoted product by product. If V3 blew up, V2 was completely unaffected. That separation was one of the best decisions we made early on — it meant we could experiment freely without the constant anxiety of "what if this breaks production."

The provisioning infrastructure was extended: new Terraform modules pointing to v3-specific paths in the infrastructure repo, new ArgoCD deployments for the v3 EKS environments, and new product v3 dev branches (e.g. `{product}-v3-dev`) that the v3 provisioners pulled from. It sounds more complicated than it was — in practice it mostly came down to naming things consistently and pointing the at the right paths.

Once all V2 DAGs for a product are migrated and validated, `v3-master` merges back into `master` and the V2 deployment gets decommissioned. That process is still ongoing for some products, but the pattern holds.

---

## 4. How Airflow 3 is fundamentally different from Airflow 2?

Before getting into the specific breaking changes, it is worth understanding _why_ so many things broke. Because when I first hit these errors, I thought I was doing something wrong. I was not — Airflow 3 is genuinely, intentionally different under the hood in ways that invalidate a lot of patterns that worked perfectly fine in Airflow 2. 
### The Airflow 2.x EOL situation

![](assets/Pasted%20image%2020260516231201.png)
https://www.astronomer.io/airflow-2-eol/

Open-source Apache Airflow 2.x officially reached end of life on **April 22, 2026**. After that date: no more security patches, no more bug fixes, no more provider package updates for the 2.x line. If you are still running Airflow 2 in production after that point, any CVE discovered in Airflow 2 or its dependencies simply goes unpatched. For a data platform handling payment transactions, "unpatched CVEs" is not a risk you want to explain to your security team. It wasn't the primary reason we migrated, but it was the reason we didn't seriously consider staying on V2 longer term.

To be fair, Airflow 2 does not have a kill switch. Your DAGs do not suddenly stop running on April 23rd. But the risk compounds quietly: dependencies drift, provider packages start requiring Airflow 3, and you find yourself maintaining a frozen environment with no upstream help. The EOL date was in the back of our minds throughout this migration as an extra nudge in the "let's actually do this properly" direction.

We were already planning the migration for architectural reasons. The EOL timeline made it feel a little more urgent.

![](assets/Pasted%20image%2020260516231342.png)
https://github.com/apache/airflow#version-life-cycle
### Airflow 2.x: everything talks to the database directly

In Airflow 2, every component — the scheduler, the webserver, the workers — communicated directly with the metadata database (typically PostgreSQL). When a worker executed a task, it opened its own database connection, read state from it, wrote XCom values to it, and could in principle reach into any table in the metadata DB it fancied. Task code ran in the same process as the worker, with no separation whatsoever between your code and Airflow's internals.

To visualize it simply:

![](assets/Pasted%20image%2020260516231041.png)

```
Airflow 2.x — everything connects to the DB directly

  Scheduler ─────────────────┐
  Webserver ─────────────────┤──── Metadata DB (Postgres)
  Workers ───────────────────┘
    └── Task code runs inside the worker process
        └── Can import Airflow ORM models directly
            └── Can read/write anything in the DB
```

This worked, but it had real problems. It was a security risk — task code could theoretically import Airflow's internal ORM models and do whatever it wanted to the metadata database, and nothing would stop it. It had scaling problems — every running task opened its own database connection, so at high concurrency you ended up hammering Postgres with connection spikes. And it was fragile — any internal schema change in Airflow could silently break shared library code that happened to reach into Airflow internals, leaving you debugging something that used to work fine and now just... doesn't.

Nobody talked about this much because it worked well enough most of the time. Until Airflow 3 came along and said: actually, no.

### Airflow 3.x: a proper client-server model

Airflow 3 introduces the Task Execution Interface (AIP-72) — the most significant architectural shift in Airflow's history. The core idea is simple but the implications are wide: tasks no longer talk to the database directly. An API Server becomes the single gatekeeper to the metadata database. Workers talk to the API Server. Your task code talks to the Task SDK. Nothing gets direct DB access anymore.

![](assets/Pasted%20image%2020260516231115.png)


```
Airflow 3.x — API server is the sole gatekeeper

  Scheduler ─────────────────┐
  React UI (FastAPI) ─────────┤──── API Server ──── Metadata DB
  DAG Processor ─────────────┘         │
                                        │
  Workers (task pods) ─────────────── API Server
    └── Task code runs in isolated subprocess
        └── No DB access at all
        └── Communicates only via Task SDK
```

The practical consequences, which I discovered the hard way:

**Task isolation.** Task code can no longer import and use Airflow's internal ORM or database sessions. If your DAG or any shared library tries to open a database session at runtime, you will immediately hit `RuntimeError: Direct database access via the ORM is not allowed in Airflow 3.0`. There is no graceful degradation. It just explodes with a RuntimeError and you spend the next hour figuring out which library buried deep in your shared code is trying to touch the database.

**Better security.** Malicious or just badly written task code can no longer access or corrupt the metadata database. The API Server is the bouncer, and it does not take bribes.

**Connection scaling.** Workers no longer open their own database connections, so connection count stays bounded regardless of how many tasks run concurrently. This is a legitimately great improvement for large deployments where Postgres connection limits were quietly becoming a problem.

**Multi-language potential.** Because the task execution interface is now API-based, future Task SDKs can target any language. Airflow 3 shipped with the Python Task SDK, with Go announced as next. Whether that excites you depends on how much of your codebase you want to rewrite.

For KubernetesExecutor specifically, the change meant worker pods no longer run persistent worker processes. In Airflow 2, a worker pod would stay alive and handle multiple tasks. In Airflow 3, the KubernetesExecutor injects task execution commands into ephemeral pods that run one task and terminate. The old `airflow worker` command from Airflow 2 is completely removed. This is also why the `executor_config` bug I hit (coming up in the war stories) was so confusing — the pod lifecycle fundamentally changed in ways that made the old dictionary-style configuration format invalid, but the failure mode was a silent task queue rather than an obvious error.

### Other things that actually improved

Beyond the core architecture, Airflow 3 ships with a fully rewritten React-based UI — genuinely much nicer than the old Flask AppBuilder interface, and not just cosmetically.

DAG Versioning finally landed too, which had been the most-requested feature in Airflow community surveys for years. In Airflow 2, deploying a new version of a DAG while it was mid-run could cause a run to execute against a confused mix of old and new task structure. In Airflow 3, a DAG run executes against the version as it was when the run started, all the way through to completion. One less thing to pray about during rolling deployments.

The REST API also moved from `/api/v1` (Flask) to `/api/v2` (FastAPI), which is noticeably faster and has proper OpenAPI documentation. A small but welcome change after years of the old Flask API being the source of at least one confusing integration per quarter.

---

## 5. Airflow 2 vs 3: the code-level changes

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

Other deprecations that will bite you: `schedule_interval` becomes `schedule`, `start_date` must be outside `default_args`, `concurrency` becomes `max_active_tasks`, and both `provide_context` and `apply_defaults` are gone since their functionality is now just... built in.

### Scheduling: the change that silently broke almost every DAG we had

I'm dedicating extra space to this one because it is sneaky. It does not throw an error. Your DAG runs, it succeeds, and you only find out something is wrong when you look at the data and go: wait, wait why tf this table empty?

In Airflow 2, scheduling a DAG with `0 0 * * *` gave you a real time window. A run triggered at midnight on Jan 2nd would have `data_interval_start = Jan 1 00:00` and `data_interval_end = Jan 2 00:00`. You'd use those to bound your Athena queries - "give me everything in this window". Completely sensible.

In Airflow 3, by default:

```
data_interval_start == data_interval_end == logical_date
```

Using the `logical_date` actually makes more human sense which should have been implemented in the past. Now all of our DAGs would need to refactored and tested to follow this new way...or is there a way to use the Airflow 2 scheduling behaviour? 

The fix is to explicitly use `CronDataIntervalTimetable`, which restores Airflow 2 interval behaviour:

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

Put this on your migration checklist and make it non-negotiable. Future you will be grateful.


---

## 6. War stories: some of the gotchas I hit in production

This is the section I wish had existed before I started. Real errors, real dates, real "wtf why is this happening??" moments from my notes. I'm putting them here so you don't have to rediscover them at midnight.

> [!NOTE] 
> A note on versions: we ran initial discovery on Airflow **3.0.6**, moved active testing to **3.1.5,** and are currently (i think) on **3.1.8** in production. 

### The executor_config default_args trap

On my early discoveries with Airflow 3.x, I hit this on the very first real DAG test in our dev environment:

```
[kubernetes_executor.py:273] ERROR - Invalid executor_config for
TaskInstanceKey(dag_id='redacted',
task_id='define_on_demand_job_arg', ...).
Executor_config: {'KubernetesExecutor': {'request_cpu': '500m',
'limit_cpu': '1000m', 'request_memory': '2Gi', 'limit_memory': '4Gi'}}
```

The task never started. No helpful error in the DAG logs and the DAG will just 'stuck' forever. We had `executor_config` set in `default_args` which is completely standard Airflow 2 pattern for specifying CPU and memory limits at the DAG level. Turns out it silently does nothing at the `default_args` level in Airflow 3. The configuration is accepted, parsed, and then ignored.

What made this particularly hard to diagnose: when `executor_config` is misconfigured at the DAG level, the scheduler does not throw an error. Instead it quietly falls back to CeleryExecutor for that task. A Celery worker pod spins up instead of a Kubernetes task pod. The task sits in queue indefinitely. You sit there refreshing the Airflow UI wondering if something is broken or if you just need to wait longer.

The tell is in the pod labels. If you see `component=worker` on the pod but no `kubernetes_executor=True` label, your task ended up on Celery. That is the first thing to check.

AAfter way too long digging through GitHub issues, the fix was moving `executor_config` to each individual `@task` decorator:

```python
# create_eks_ondemand_override is a sharedlib used with kubernetes.client.models.V1Pod
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

### create_or_update_pool and the ORM wall

We used `create_or_update_pool` in a few DAGs to dynamically manage Airflow pool slots at startup. In Airflow 3, the moment that code runs, you get:

```
RuntimeError: Direct database access via the ORM is not allowed in Airflow 3.0
```

No partial success, no graceful fallback. The task just dies. This is exactly the Task SDK wall from Section 4 showing up in practice. The fix: use the new REST API (`/api/v2`) to create and update pools from outside the DAG context or don't use pools at all (which for our case, we removed it entirely).

### The data_interval_start == data_interval_end surprise (the worst one)

I've already covered this in the scheduling section, but it deserves a war story mention because of how it manifested. I ran a refactored DAG, it completed successfully, and I went off to check the output table. Empty. Completely empty.

My first reaction was that I had the UNLOAD query wrong. Checked the SQL. Fine. Ran it manually in Athena. Got data. Checked the DAG logs. No errors. Checked the Iceberg table. Definitely empty.

It took embarrassingly long to figure out that both `data_interval_start` and `data_interval_end` were pointing to the same timestamp, so the query's `WHERE date >= start AND date < end` was filtering out literally everything. The window was zero seconds wide.

Given our strict SLA requirements, this could've been an operational nightmare if we hadn't find out sooner. At least a crash alerts someone while an empty report is not really ideal .

```python
# What we had — looks fine, worked in Airflow 2
start = context['data_interval_start']  # e.g. 2025-12-09 00:00
end = context['data_interval_end']      # e.g. 2025-12-10 00:00

query = f"""
    SELECT * FROM product_raw.transaction_log
    WHERE date >= '{start.date()}' AND date < '{end.date()}'
"""

# In Airflow 3 without CronDataIntervalTimetable:
# start == end == logical_date → zero-width window → empty result → silent ✓
```

Switching to `CronDataIntervalTimetable` resolved it. We then added it to the mandatory migration checklist so nobody else had to experience the "why is my table empty" moment.

---

## 7. Our shared libraries were f****d too

When I was 'in the zone' of doing discovery for Airflow 3, I soon realized that I had to refactor the **ENTIRE** shared library that we had for Airflow. It had to be rebuilt from scratch on a protected branch, separate from the Airflow 2 shared library that was still in use. "Rebuilt from scratch" is not exaggeration btw because there were too many breaking changes in some of the important libraries that we use. So, I took the opportunity to remove everything that wasn't being used in production (there was more of that than anyone wanted to admit), merge redundant utilities into their correct homes, and organize things so that a new engineer could read the directory tree and understand where to look.

The structure ended up looking something like below Your wn library will look different depending on your stack, but the `processor/` layer is the meaningful new addition — it is the glue between Athena, Polars, and PyIceberg that the rest of the article describes:

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
    ├── cdc_helper/                # CDC/streaming ingestion helpers (e.g. Debezium/Kafka)
    ├── dq_helper/                 # Data quality monitoring
    ├── dt_helper/                 # Date/time utilities
    ├── sql_helper/                # Athena query helpers (IRSA-based)
    └── processor/                 # Core ETL processors
        ├── athena_helper.py       # Athena UNLOAD utilities
        ├── loader.py              # IcebergLoader (Polars -> PyArrow -> PyIceberg)
        ├── reader.py              # S3 Parquet reader (Polars)
        └── transformer.py        # Data transformation utilities
```

The migration made years of accumulated debt visible all at once. I cleaned it up while I had the chance and the motivation. Future engineers navigating this codebase will hopefully never know what it used to look like. Engineers are expected to extend it as they migrate their own pipelines, reiterating in the process.

---
## 8. The new ETL stack: Polars, PyArrow, and PyIceberg

With Spark and EMR gone from the critical path, we needed a new way to load data into Iceberg tables in the consumable/gold layer. The answer was a pure Python pipeline built around 3 libraries: Polars for reading and light transformation (think Pandas but significantly faster on columnar data, with lazy evaluation and zero-copy Arrow integration), PyArrow for schema casting and serialisation, and PyIceberg for writing to Glue Iceberg tables directly. And honestly, once it was working, I didn't miss Spark at all.

> **[Diagram: ETL pipeline flow — see published article]**

The high-level flow for every ETL DAG:

```
pre-ETL setup
    → Athena UNLOAD  (query ingestion layer, write Parquet to S3 temp path)
    → Polars read    (read Parquet from S3 temp — no schema enforcement yet)
    → PyArrow cast   (enforce schema from data_contract.py)
    → PyIceberg write  (load to Glue Iceberg table)
    → end
```

### Athena UNLOAD

The first step queries the ingestion layer and writes Parquet to a temporary S3 path. The `.sql` file contains only the `SELECT` — the `UNLOAD` wrapper is built in the DAG. This keeps the SQL files clean and reusable outside of Airflow context:

```python
query_template = get_query(OUTGOING_QUERY_FILE)
temp_s3_path = construct_s3_path(TEMP_S3_PATH, outgoing_config['sink_table'])

query = query_template.format(
    PATTERN_START=job_params['PATTERN_START'],
    PATTERN_END=job_params['PATTERN_END']
)

formatted_query = f"""
UNLOAD (
    {query}
)
TO '{temp_s3_path}'
WITH (
    format = 'PARQUET',
    compression = 'SNAPPY',
    partitioned_by = ARRAY['year_month']
)
"""

execute_athena_query(
    query_string=formatted_query,
    output_location=os.environ['ATHENA_S3_OUTPUT'],
    creds=creds,
    ti=kwargs['ti']
)
```

### Schema contract via data_contract.py

Each product defines its table schema in a `data_contract.py` file — the single source of truth for schema and partitioning. This replaced a messier pattern where schema was defined in two different places and could silently drift out of sync (the kind of thing you only notice when something breaks in production at the worst possible time):

```python
from pyiceberg.schema import Schema
from pyiceberg.types import NestedField, StringType, LongType, TimestampType
from pyiceberg.partitioning import PartitionSpec, PartitionField
from pyiceberg.transforms import IdentityTransform

data_contract = {
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

### Loading to Iceberg

The `IcebergLoader` function reads Parquet with Polars, casts it to the schema via PyArrow, and writes to Glue via PyIceberg. The whole flow is Python. No JVM, no cluster, no waiting for Spark to decide it's ready:

```python
@task(on_failure_callback=opsgenie_callback)
def load_data_to_glue_catalog(**kwargs):
    """Polars -> PyArrow -> PyIceberg (zero-copy flow)"""
    creds = get_aws_execution_role_creds()

    temp_s3_path = construct_s3_path(TEMP_S3_PATH, consumable_config['sink_table'])
    df_pl = pl_read_parquet_from_s3(f"{temp_s3_path}/*", creds=creds)

    # Three supported write modes:
    # 'insert_into'      -> append, fastest, no deduplication
    # 'overwrite'        -> merge then replace entire table
    # 'insert_overwrite' -> dynamic partition overwrite (only affected partitions)
    load_to_iceberg(
        pl_df=df_pl,
        database=f"{db_tag}{incoming_config['target_database']}",
        table_name=incoming_config['sink_table'],
        data_contract=data_contract,
        mode='overwrite',
        merge_keys=['trxn_id'],
        partition=['year_month'],
        creds=creds
    )
```

The three write modes map directly to what we had in the old Spark-based loader, so the migration didn't really require rethinking the data semantics, just swapping the engine underneath. That made the transition much smoother than expected.


> [!NOTE] Processing data in Airflow
> While yes, Airflow is supposed to be used solely as an orchestration tool and not to do pure ETL, the ETL process now becomes light enough to be run on each task per pod on our kubernetes environment. Thus, this has simplified our approach in doing development


---

## 9. Security improvement: from static keys to IRSA

One genuinely satisfying change that came with the migration: we removed all hardcoded `aws_access_key_id` and `aws_secret_access_key` usage from every operator. Airflow worker pods now use IRSA (IAM Roles for Service Accounts) via Kubernetes and OIDC, dynamically assuming product-specific roles through AWS STS `AssumeRole`.

```python
# Before (Airflow 2 — hardcoded credentials living in environment variables, cursed)
AthenaQueryOperator(
    task_id="my_query",
    sql="SELECT ...",
    aws_access_key_id=os.getenv('AWS_PRODUCT_SVC_BOT_ACCESS'),      # removed
    aws_secret_access_key=os.getenv('AWS_PRODUCT_SVC_BOT_SECRET'),  # removed
    output_location=os.getenv('ATHENA_S3_OUTPUT'),
    target_assume_role=os.getenv('EXECUTION_ROLE_ARN'),
)

# After (Airflow 3 — IRSA handles it, no credentials in sight)
AthenaQueryOperator(
    task_id="my_query",
    sql="SELECT ...",
    output_location=os.getenv('ATHENA_S3_OUTPUT'),
    target_assume_role=os.getenv('EXECUTION_ROLE_ARN'),
    aws_region='ap-southeast-1',
    on_failure_callback=generate_opsgenie_callback(onprem=False, tag="my-product"),
)
```

The auth flow is: EKS pod uses IRSA to assume the default Airflow IAM role, which calls `sts:AssumeRole` to get a product-scoped role, which is what actually accesses S3, Glue, and Athena. No static credentials anywhere in the pipeline. A small thing in terms of code changes, but a meaningful one in terms of security posture.

---

## 10. Consumable layer setup: what you need to provision

Setting up the consumable layer is not complicated, but the order of operations matters — especially for Lake Formation, which has a particular talent for producing cryptic permission errors when you do things out of sequence and absolutely zero sympathy for anyone who skips a step (I still have PTSD from setting this shit up). In our case, we tried to configure cross-account access on an empty Glue database before any tables existed. The LF tag permissions need at least one table present to validate against, and the error you get back does not tell you this. That costed me a whole day to pull my non-existing hair and figure things out but it worked out in the end.

**Lake Formation** cross-account access — if you're using QuickSight or any cross-account BI tool to query these tables, sequence matters. Do this in order:

1. Create the S3 bucket with LF cross-account enabled
2. Create the Glue database using the correct LF tag — skipping or using the wrong tag is the single most common mistake and produces permission errors that will send you in circles
3. Enable cross-account access _after_ tables exist — trying to configure it on an empty database gives an error that does not explain this is the reason
4. Update access group definitions to include the new databases with the appropriate LF tag
5. Attach IAM policies to the roles that need consumable access

**IAM policies** also need updating if you are renaming anything as part of the migration. Both nonprod and prod environments need separate passes. It is easy to finish one and forget the other.

---

## 11. Dev workflow: how we stopped waiting 30 minutes to test a one-line change

Before this migration, the development cycle for a DAG change felt like a punishment. Write code locally, commit, open a merge request, merge into our repo, wait for the Airflow S3 sync cron job to run and sync, then check airflow to see if your change appeared. Rinse and repeat. A single iteration could easily take 20 to 30 minutes. For exploratory work where you're trying ten different things, this can be quite a hassle sometimes (ok truthfully all time unless you were already writing the initial ETL development with Jupyter Notebooks).

The new approach was a local `airflow-v3` Docker Compose setup. Engineers point it at their specific dev branches, and DAG changes reflect immediately in the local Airflow UI. Change a file, see it pick up almost instantly. It felt like cheating (ok not really but this was miles faster for development for us).

```
Dev options, ranked by speed:

Local compose (fastest — and what I now use by default)
    Points to: repo dev branches
    Changes reflect: immediately on file save
    Can test: DAG logic, Athena queries, Polars transforms
    Cannot test: KubernetesExecutor behaviour

airflow on EKS (when you actually need K8s)
    Commit and push to dev branch
    Create MR and push to repo
	Wait for S3 sync
    Required for: executor_config, pod resource limits, node affinity
```

The local compose is not a perfect production replica.  Task execution is faster locally and you cannot test `KubernetesExecutor` behaviour. But for the majority of logic-level development, it reduced the feedback loop from half an hour to near-instant. That change alone made the migration feel significantly less painful.


---

## 12. Trade-offs and what's still unresolved

I want to be honest about this part, because most engineering articles end with "and then everything was great." That's not quite where we landed.

**Data accuracy during merges.** The `overwrite` mode in `IcebergLoader` does a merge-then-replace of the entire table with deduplication on merge keys. I tested this thoroughly in development, but data loss edge cases during high-volume merges have not been fully characterized at production scale. `insert_overwrite` is safer for append-heavy patterns. The right mode genuinely depends on each pipeline's semantics, and we are still figuring out the right defaults per use case.

**Schema handling — two schools of thought, no verdict yet.** There is an ongoing internal debate about where schema should live: in `data_contract.py` with explicit PyIceberg types (current approach), or defined entirely in the Athena SQL and enforced through UNLOAD output. Both work. Both have advocates. This will probably evolve as more pipelines migrate and we learn which approach causes fewer headaches in practice.

There are probably more things that I have not discovered that hopefully all my other talented engineers got the bingo moment and reiterate on their own.


---

## 13. How it came together

I want to be transparent about something: I did the initial discovery and infrastructure setup, but this architecture did not come from one person sitting in a room having brilliant ideas.

I spent roughly six weeks doing what I would describe as aggressive exploration. Deploying and exploring Airflow 3 on EKS, building the first version of Airflow 3 shared libraries from scratch, hitting every breaking change documented in this article (and a few more that didn't make the cut), and writing everything down so the team didn't have to rediscover the same walls. By late December 2025, the first pipelines (starting with the highest-volume product in the lake) were running in production on the new architecture.

But what made this work was how the team engaged with it. My principal engineers and heads challenged assumptions and pushed back on early design decisions in ways that made the architecture significantly better — the schema handling approach, the IRSA setup, the Lake Formation configuration all improved through those conversations. My team leads created space for iteration instead of pressure to lock things in early. Other data engineers who came in to migrate their own pipelines found edge cases I had completely missed and contributed fixes back to the shared library and pipelines.

That back-and-forth is what turned a rough proof-of-concept into something durable. The speed at which we moved from first exploration to production infrastructure in under two months was only possible because everyone leaned in and took it seriously. I genuinely could not have done it alone, and I wouldn't have wanted to.

---

## The timeline

For anyone curious about what "under two months" actually looked like on the ground — here's the rough shape of it:

**Early November 2025** — first conversations started about refactoring to a 2-layer architecture. The goal at this point was purely about eliminating the Spark/EMR layer and moving transformation logic into the raw ingestion. Airflow 3 was not yet on the radar and we were still thinking in terms of Airflow 2 pipelines querying a cleaner raw layer.

**~10 December 2025** — finished migrating the first set of products to the new ingestion approach, with transformation logic baked into ingestion. The raw tables were now Athena-queryable directly.

**12 December** — started discussions about Airflow 3 and what a full refactor of the pipeline layer would look like. This is the point where the scope doubled from "cleaner raw layer" to "entirely new orchestration architecture."

**13 December** — began active discovery: diving into Airflow 3 breaking changes, slowly refactoring shared libraries, setting up the v3 infrastructure, and running the first POCs. Also the date I started keeping the notes that became the internal Confluence docs, and eventually this article.

**26 December** — finished the first complete version of all Airflow 3 documentation, shared library refactoring to production-ready state, and infrastructure setup. First DAGs using the Polars → PyArrow → PyIceberg pipeline were being refactored and validated. (at this point I was just happy that it worked lol).

**~16 January 2026** — started presenting the new architecture and migration planning to the broader Data Engineering team, sharing the docs and seeking feedback from other DEs and principal engineers.

**16 January onwards** — all DEs began refactoring their own product pipelines to the new architecture, with ongoing collaboration to improve and iterate on the patterns, fix edge cases I hadn't anticipated, and standardize anything that hadn't been nailed down yet.

From first conversation to production infrastructure: roughly ten weeks. From "Airflow 3 is now part of the plan" to first production DAGs: about two weeks. The speed was only possible because the team was fully bought in and the isolation strategy (separate V2 and V3 deployments) meant we were never betting production stability on something unproven.

---

## Reflections

If I were doing this again, I would do a few things differently.

Don't refactor V2 pipelines before migrating to V3. Cleaning up Airflow 2 code only to refactor it again for Airflow 3 is doing the same work twice and annoying yourself in the process. The moment we decided to skip the V2 cleanup and go straight to V3 was the moment the migration started feeling tractable rather than endless.

`CronDataIntervalTimetable` is non-negotiable if your DAGs use time windows unless you want to go ahead with the new and _improved_ way of doing scheduling in Airflow 3. If there is one thing to take away from this article, it is this. A DAG that silently produces empty output and reports success — especially one feeding a settlement report with a hard delivery window — is the worst kind of bug: invisible until it really matters.

The broader lesson from all of this is that a version migration and an architecture migration are two genuinely different problems, and we had to solve both simultaneously. Airflow 3 forced us to rethink how tasks run. The 2-layer architecture forced us to rethink where transformation logic lives. But the two reinforced each other in a way I didn't expect when we started: the Python-native toolchain that Airflow 3 pushes you toward — Polars, PyArrow, PyIceberg — turned out to be exactly good enough to replace Spark for our use cases. Without Airflow 3 as the forcing function, we might have stayed on Spark out of inertia and just lived with the cost and recovery time. The version upgrade and the architecture change ended up being inseparable.

What also surprised me was how much writing things down mattered. The internal docs I started which were initially just notes for myself to not forget what I'd broken became the onboarding material for the entire team. If you are doing a migration like this, write as you go. Your future teammates will thank you, and so will future-you when you have to explain a decision you made at 2am on a random Wednesday in December.

The migration is still ongoing as other pipelines in Airflow 2 follow the same path. But the foundation is there: the shared library is built, the consumable layer standards are defined, the infrastructure is provisioned, and the team knows the playbook well enough to extend and improve it on their own.

Forty DAGs down to twenty-four. No EMR in the critical path. Settlement data queryable from the moment ingestion finishes, with SLAs that are actually achievable now.

That is absolutely worth a few weeks of 2am debugging sessions.

_If you are going through a similar migration, feel free to reach out. The Airflow 3 community is still building out its collective knowledge — every shared war story helps._

---

**References**

- [Apache Airflow 3 is Generally Available](https://airflow.apache.org/blog/airflow-three-point-oh-is-here/)
- [Upgrading to Airflow 3 — Official Documentation](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html)
- [AIP-72: Task Execution Interface](https://cwiki.apache.org/confluence/display/AIRFLOW/AIP-72+Task+Execution+Interface+aka+Task+SDK)
- [Airflow 3 DAG Scheduling — Marc Lamberti](https://www.linkedin.com/posts/marclamberti_apache-airflow-3-dag-scheduling-changes-activity-7318919991024013312-mLDZ)