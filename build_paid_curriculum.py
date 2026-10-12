#!/usr/bin/env python3
"""
Build the complete 36-Module curriculum for 'TrendyTech Ultimate Big Data Masters Program'
from paid_catalog.json (404 video lectures + 174 study materials = 578 items),
and register the course, syllabus, learning path, cover, and enrollments in CourseForge.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

COURSE_KEY = "TrendyTech Ultimate Big Data Masters Program"
COURSE_TITLE = "Ultimate Big Data Masters Program (Cloud Data Engineering)"
COURSE_INSTRUCTOR = "Sumit Mittal (TrendyTech)"
COURSE_CATEGORY = "Big Data & Cloud Data Engineering"
COURSE_TAGS = [
    "Big Data", "Apache Spark", "PySpark", "Databricks", "Delta Lake",
    "Azure Data Factory", "Azure Synapse", "AWS Glue", "AWS EMR", "Redshift", "Kafka", "Hadoop"
]
COURSE_DESCRIPTION = (
    "Ultimate Big Data Masters Program (Cloud Data Engineering) by Sumit Mittal (TrendyTech) — "
    "Complete 34-Week, 36-Module curriculum with 404 video lectures and 174 study materials (running notes, "
    "summary PDFs, assignments, solutions, and code/dataset archives) covering Hadoop, HDFS, MapReduce, "
    "Apache Spark Core & SQL, Spark Internals & Optimization, Lending Club Capstone, Pytest, CI/CD, "
    "Apache Hive, Azure Cloud, Databricks Masters & Expert (Delta Lake, Unity Catalog, Lakeflow, DLT, "
    "Medallion Architecture, Asset Bundles), Azure Data Factory (ADF), Dimensional Data Modeling, "
    "Azure Synapse, Spark Structured Streaming, Apache Kafka, and AWS Data Engineering (S3, Athena, EC2, "
    "EMR Serverless, Glue ETL, Redshift, Lambda, and End-to-End AWS Pipeline Project)."
)

MODULES = [
    (1, 1, 8, "Week 01", "Big Data, Hadoop, Cloud & Spark Foundations", [
        "Understand monolithic vs distributed architectures and the Big Data ecosystem",
        "Compare Databases, Data Warehouses, and Data Lakes (DB vs DWH vs DL)",
        "Master HDFS architecture, block replication, and NameNode/DataNode internals",
    ]),
    (2, 9, 15, "Week 02", "HDFS Architecture, Linux CLI & MapReduce Intro", [
        "Execute essential Linux shell and HDFS file system commands in lab environments",
        "Compare on-premise HDFS storage with cloud data lakes (ADLS Gen2 & Amazon S3)",
        "Understand the MapReduce programming paradigm and data locality",
    ]),
    (3, 16, 25, "Week 03", "MapReduce Deep Dive & Getting Started with Apache Spark", [
        "Implement Map, Shuffle, Sort, and Reduce phases across distributed clusters",
        "Transition from disk-based MapReduce to in-memory Apache Spark processing",
        "Write and execute your first Apache Spark application",
    ]),
    (4, 26, 36, "Week 04", "Apache Spark Core APIs & RDD Fundamentals", [
        "Master Resilient Distributed Datasets (RDDs), lazy evaluation, and DAG lineage",
        "Apply narrow vs wide transformations and actions using PySpark Core APIs",
        "Build word-count, log-analysis, and key-value pair RDD pipelines",
    ]),
    (5, 37, 45, "Week 05", "Spark Transformations, Actions & Execution Model", [
        "Use Broadcast variables and Accumulators for distributed shared state",
        "Analyze Spark jobs, stages, shuffle boundaries, and tasks in the Spark Web UI",
        "Optimize RDD partitioning with repartition and coalesce",
    ]),
    (6, 46, 55, "Week 06", "Spark SQL & DataFrames Part 1 (Structured APIs)", [
        "Create SparkSession applications with explicit schemas and DataFrame readers",
        "Switch seamlessly between DataFrame transformations and Spark SQL queries",
        "Work with Catalyst Optimizer expressions, columns, and built-in functions",
    ]),
    (7, 56, 64, "Week 07", "Spark SQL, Joins & Window Functions Part 2", [
        "Perform inner, outer, semi, anti, and cross joins on large-scale DataFrames",
        "Write analytical Window functions (row_number, rank, dense_rank, lead, lag)",
        "Handle corrupt records, nulls, date/timestamp parsing, and complex JSON types",
    ]),
    (8, 65, 75, "Week 08", "Spark Internals, Partitioning & Aggregations", [
        "Understand hash partitioning vs range partitioning and bucketing",
        "Compare groupByKey vs reduceByKey vs treeAggregate at scale",
        "Inspect physical execution plans and Tungsten binary memory representation",
    ]),
    (9, 76, 86, "Week 09", "Apache Spark Performance Optimization Part 1", [
        "Tune Broadcast Hash Joins vs Sort Merge Joins and handle data skew",
        "Configure caching and persistence storage levels (MEMORY_AND_DISK_SER)",
        "Eliminate shuffle bottlenecks and predicate pushdown inefficiencies",
    ]),
    (10, 87, 96, "Week 10", "Apache Spark Memory Management & Cluster Tuning", [
        "Calculate executor memory, overhead, unified storage/execution pools, and cores",
        "Diagnose OutOfMemoryError (OOM) on driver vs executors and garbage collection",
        "Enable Dynamic Resource Allocation and Adaptive Query Execution (AQE)",
    ]),
    (11, 97, 107, "Week 11", "Spark Optimization Part 2, File Formats & Compression", [
        "Compare row vs columnar formats: CSV, JSON, Avro, ORC, and Apache Parquet",
        "Evaluate Snappy, Gzip, LZO, and Zstd compression codecs and splittability",
        "Apply schema evolution, partition pruning, and vectorization",
    ]),
    (12, 108, 130, "Milestone 01", "Lending Club End-to-End Spark Capstone, Agile, Pytest & Log4j", [
        "Architect a production-grade financial risk pipeline on the Lending Club dataset",
        "Structure modular PySpark repositories with virtual environments and ConfigParser",
        "Write unit tests with Pytest, structured logging with Log4j, and follow Agile sprints",
    ]),
    (13, 131, 146, "Week 12", "Git, GitHub Workflows & CI/CD Data Pipelines", [
        "Master Git branching strategies, pull requests, rebasing, and merge conflict resolution",
        "Build automated CI/CD workflows with GitHub Actions for PySpark testing and deployment",
        "Automate artifact packaging and multi-environment release promotion",
    ]),
    (14, 147, 172, "Week 13", "Apache Hive, ACID Transactions, Interviews & Career Prep", [
        "Design Hive external/managed tables, dynamic partitioning, bucketing, and MSCK repair",
        "Implement Hive ACID transactional tables and Hive-Spark Metastore integration",
        "Crack cluster resource estimation interviews and optimize Resume/LinkedIn/Naukri profiles",
    ]),
    (15, 173, 183, "Week 14", "Microsoft Azure Cloud Fundamentals for Data Engineers", [
        "Provision Azure Resource Groups, Subscriptions, IAM RBAC, and Virtual Networks",
        "Configure Azure Blob Storage and Azure Data Lake Storage Gen2 (ADLS Gen2)",
        "Secure cloud credentials using Azure Key Vault, Service Principals, and Managed Identities",
    ]),
    (16, 184, 193, "Week 15", "Databricks Masters Week 1 — Workspace, Clusters & Notebooks", [
        "Architect Azure Databricks workspaces, all-purpose vs job compute, and cluster policies",
        "Use Databricks Utilities (dbutils) for file systems, secrets, widgets, and notebook chaining",
        "Mount and query ADLS Gen2 storage using Unity Catalog / Service Principals",
    ]),
    (17, 194, 204, "Week 16", "Databricks Masters Week 2 — Delta Lake Architecture & Practicals", [
        "Understand the Delta Transaction Log (_delta_log), Parquet data files, and ACID guarantees",
        "Perform Time Travel, Version History, Schema Enforcement, and Schema Evolution",
        "Execute MERGE INTO (Upserts), DELETE, UPDATE, OPTIMIZE (Z-Order), and VACUUM",
    ]),
    (18, 205, 214, "Week 17", "Databricks Expert Week 3 — Unity Catalog & Governance", [
        "Configure 3-level namespace (Catalog.Schema.Table) and external locations in Unity Catalog",
        "Enforce fine-grained row filters, column masks, and data lineage tracking",
        "Manage Delta Sharing, managed vs external tables, and storage credentials",
    ]),
    (19, 215, 224, "Week 18", "Databricks Expert Week 4 — Delta Lake & Performance Tuning", [
        "Optimize Delta Lake workloads with Liquid Clustering, Deletion Vectors, and Predictive I/O",
        "Leverage Change Data Feed (CDF) for incremental downstream table propagation",
        "Tune Photon vectorized execution and shuffle partitions on Databricks",
    ]),
    (20, 225, 235, "Week 19", "Databricks Expert Week 5 — Lakeflow & Cloud File Ingestion", [
        "Ingest millions of cloud files incrementally using Databricks Auto Loader (cloudFiles)",
        "Configure schema inference, schema evolution, and rescue data columns in Auto Loader",
        "Orchestrate multi-hop Bronze-Silver-Gold ingestion flows",
    ]),
    (21, 236, 245, "Week 20", "Databricks Expert Week 6 — Lakeflow Declarative Pipelines (DLT)", [
        "Build declarative streaming tables and materialized views with Delta Live Tables (DLT)",
        "Enforce data quality expectations (expect, expect_or_drop, expect_or_fail)",
        "Implement Automated SCD Type 1 and SCD Type 2 with APPLY CHANGES INTO",
    ]),
    (22, 246, 256, "Week 21", "Databricks Expert Week 7 — Lakeflow Jobs & Managed Connectors", [
        "Ingest enterprise databases using Lakeflow Connect managed connectors",
        "Design multi-task Databricks Workflow Jobs with conditional branching, retries, and parameters",
        "Monitor job runs, alerts, repair runs, and serverless job compute",
    ]),
    (23, 257, 261, "Week 22", "Databricks Expert Week 8 — Medallion Architecture & Orchestration", [
        "Design end-to-end Bronze, Silver, and Gold Lakehouse layers with Delta Lake",
        "Implement idempotent incremental processing and metadata-driven orchestration",
        "Integrate quality gates and audit logging across Medallion layers",
    ]),
    (24, 262, 274, "Week 23", "Databricks Expert Week 9 — Asset Bundles (DAB) & CLI Deployment", [
        "Package notebooks, jobs, and DLT pipelines using Databricks Asset Bundles (databricks.yml)",
        "Deploy across dev, staging, and prod targets via Databricks CLI and CI/CD",
        "Manage production secrets, permissions, and wheel package dependencies",
    ]),
    (25, 275, 285, "Week 24", "Azure Data Factory (ADF) Part 1 — Pipelines, Datasets & Activities", [
        "Build ADF Linked Services, Datasets, Copy Activity, and Integration Runtimes (AutoResolve & SHIR)",
        "Use Lookup, Get Metadata, If Condition, ForEach, Filter, and Wait control-flow activities",
        "Parameterize dynamic pipelines with ADF system variables and expressions",
    ]),
    (26, 286, 290, "Week 25", "Azure Data Factory (ADF) Part 2 — Real-World Use Cases & Triggers", [
        "Implement incremental watermark loading and Mapping Data Flows in ADF",
        "Schedule pipelines with Schedule, Tumbling Window, and Storage Event triggers",
        "Integrate ADF with Azure Key Vault, Databricks notebooks, and alerts",
    ]),
    (27, 291, 298, "Week 26", "Dimensional Data Modeling & Enterprise Data Warehousing", [
        "Design Star Schema and Snowflake Schema fact and dimension tables",
        "Implement Slowly Changing Dimensions (SCD Type 0, 1, 2, 3, 4, and 6)",
        "Model surrogate keys, grain declarations, conformed dimensions, and factless facts",
    ]),
    (28, 299, 331, "Milestone 02", "Azure End-to-End Pipeline Capstone, SCD2, Azure Synapse & Interviews", [
        "Build an end-to-end Azure Data Engineering pipeline combining ADF, ADLS Gen2, Databricks, and Synapse",
        "Master Azure Synapse Dedicated SQL Pools, Serverless SQL, distribution styles (Hash/Round-Robin/Replicated), and POLYBASE/COPY",
        "Prepare for real-world Azure Storage, ADF, and Synapse architecture interviews",
    ]),
    (29, 332, 339, "Week 27", "Spark Structured Streaming Part 1 — Real-Time Data Processing", [
        "Understand micro-batch vs continuous streaming execution and output modes (Append, Update, Complete)",
        "Read from socket, file, and Delta streaming sources with fault-tolerant checkpointing",
        "Perform stateless and stateful streaming transformations and aggregations",
    ]),
    (30, 340, 345, "Week 28", "Spark Structured Streaming Part 2 — Watermarking & Stream Joins", [
        "Handle late-arriving out-of-order events using tumbling/sliding windows and Watermarking",
        "Execute Stream-Static and Stream-Stream joins with state cleanup",
        "Ensure exactly-once end-to-end semantics in production streaming sinks",
    ]),
    (31, 346, 353, "Week 29", "Ultimate Apache Kafka for Data Engineers", [
        "Understand Kafka brokers, topics, partitions, consumer groups, offsets, and KRaft/ZooKeeper",
        "Build Kafka Producers and Consumers integrated with Spark Structured Streaming",
        "Tune replication factor, ISR, acks, and retention policies for high throughput",
    ]),
    (32, 354, 361, "Week 30", "Big Data on AWS Cloud — Amazon S3, Athena & EC2", [
        "Configure Amazon S3 buckets, storage classes, lifecycle policies, and IAM roles",
        "Query partitioned S3 data lakes serverlessly using Amazon Athena and Glue Catalog",
        "Launch and secure Amazon EC2 instances for data engineering workloads",
    ]),
    (33, 362, 368, "Week 31", "Big Data on AWS Cloud — Amazon EMR & EMR Serverless", [
        "Provision managed Spark/Hadoop clusters on Amazon EMR with S3 (EMRFS)",
        "Submit and scale PySpark jobs on Amazon EMR Serverless without cluster management",
        "Optimize spot/on-demand task nodes and auto-scaling policies",
    ]),
    (34, 369, 382, "Week 32", "AWS Glue Data Catalog, Crawlers & Serverless Glue ETL", [
        "Automate schema discovery on S3 using AWS Glue Crawlers and Data Catalog",
        "Author serverless PySpark ETL jobs using Glue DynamicFrames, bookmarks, and workflows",
        "Tune AWS Glue worker types (G.1X, G.2X), job bookmarks, and error handling",
    ]),
    (35, 383, 394, "Week 33", "Amazon Redshift, AWS Lambda & Event-Driven S3 Architecture", [
        "Architect Amazon Redshift clusters, distribution styles (KEY, EVEN, ALL), and sort keys",
        "Load data at scale with Redshift COPY, Redshift Spectrum, and WLM queues",
        "Build event-driven serverless data ingestion with AWS Lambda, Layers, and S3 triggers",
    ]),
    (36, 395, 404, "Week 34", "AWS End-to-End Cloud Data Pipeline Capstone Project", [
        "Architect a complete production AWS Data Lakehouse pipeline using S3, Lambda, Glue, EMR, Redshift, and Athena",
        "Implement automated job orchestration, data cataloging, and BI reporting layers",
        "Apply security, IAM least privilege, cost optimization, and production monitoring",
    ]),
]


def get_module_for_video(idx: int) -> tuple[int, str, str, list[str]]:
    for mod_num, start_i, end_i, week_tag, mod_title, objs in MODULES:
        if start_i <= idx <= end_i:
            return mod_num, week_tag, mod_title, objs
    return 36, "Week 34", "AWS End-to-End Cloud Data Pipeline Capstone Project", []


def format_video_title(idx: int, orig_name: str, caption: str) -> str:
    mod_num, week_tag, mod_title, _ = get_module_for_video(idx)
    raw = caption.strip().splitlines()[0].strip() if caption and caption.strip() else orig_name.strip()
    # Remove bot spam and trailing noise
    raw = re.sub(r"Downloaded using\s*@?\S*", "", raw, flags=re.IGNORECASE).strip()
    raw = re.sub(r"_\d{9,11}(?=\.[a-zA-Z0-9]+$|$)", "", raw)
    for _ in range(4):
        raw = re.sub(r"\.(mp4|webm|mkv|mov|mux)$", "", raw, flags=re.IGNORECASE).strip()
    raw = re.sub(r"\s+L$", "", raw).strip()
    # Strip leading week prefix from raw since we prepend normalized week_tag
    raw = re.sub(r"^(wee+k\s*[-_]?\s*\d+\s*[-_:]?\s*)", "", raw, flags=re.IGNORECASE).strip()
    raw = raw.replace("_", " ").replace("  ", " ").strip(" -_.")
    if not raw:
        raw = f"{mod_title} Session {idx}"
    # Capitalize cleanly
    cleaned = re.sub(r'[\\/*?:"<>|]', "-", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return f"[{idx:03d}] {week_tag} ({mod_title.split('—')[0].strip()}) - {cleaned}"[:170]


def format_material_filename(idx: int, orig_name: str, caption: str, ext: str) -> str:
    base = orig_name.strip()
    # Strip leading numeric IDs like 3709761- or 5025243-3743120-
    base = re.sub(r"^(\d{5,9}-)+", "", base)
    base = re.sub(r"_\d{9,11}(?=\.[a-zA-Z0-9]+$|$)", "", base)
    base = re.sub(r"\.(pdf|zip|txt|ipynb)$", "", base, flags=re.IGNORECASE).strip()
    base = base.replace("_", " ").strip(" -_.")

    cap = (caption or "").strip()
    cap = re.sub(r"Downloaded using\s*@?\S*", "", cap, flags=re.IGNORECASE).strip()
    week_hint = ""
    m_cap = re.search(r"(week\s*[-_]?\s*\d+|milestone\s*[-_]?\s*\d+)", cap, flags=re.IGNORECASE)
    m_base = re.search(r"(week\s*[-_]?\s*\d+|milestone\s*[-_]?\s*\d+)", base, flags=re.IGNORECASE)
    if m_base:
        pass
    elif m_cap:
        week_hint = m_cap.group(1).title().replace("-", " ") + " - "

    cleaned = re.sub(r'[\\/*?:"<>|]', "-", f"{week_hint}{base}").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return f"[{idx:03d}] {cleaned[:150]}{ext}"


def video_id_for_path(path_str: str) -> str:
    return hashlib.sha1(path_str.encode("utf-8")).hexdigest()[:24]


def main():
    catalog_path = Path("/Users/lavkushkumar/Desktop/Courses/paid_catalog.json")
    items = json.loads(catalog_path.read_text())

    enriched = []
    for item in items:
        idx = item["idx"]
        ext = item["ext"]
        if ext == ".mp4":
            title = format_video_title(idx, item["orig_name"], item["caption"])
            fname = f"{title}.mp4"
            mod_num, week_tag, mod_title, objs = get_module_for_video(idx)
            rel_path = f"{COURSE_KEY}/{fname}"
            vid_id = video_id_for_path(f"/Users/lavkushkumar/Desktop/Courses/{rel_path}")
            enriched.append({
                **item,
                "kind": "video",
                "title": title,
                "clean_filename": fname,
                "module_num": mod_num,
                "week_tag": week_tag,
                "module_title": f"Module {mod_num:02d}: {week_tag} — {mod_title}",
                "video_id": vid_id,
            })
        else:
            fname = format_material_filename(idx, item["orig_name"], item["caption"], ext)
            enriched.append({
                **item,
                "kind": "material",
                "title": Path(fname).stem,
                "clean_filename": fname,
            })

    out_path = Path("/Users/lavkushkumar/Desktop/Courses/paid_curriculum.json")
    out_path.write_text(json.dumps(enriched, indent=2))
    print(f"Wrote {len(enriched)} curriculum items to {out_path}")

    videos = [x for x in enriched if x["kind"] == "video"]
    materials = [x for x in enriched if x["kind"] == "material"]
    print(f"  -> {len(videos)} videos across {len(MODULES)} structured modules")
    print(f"  -> {len(materials)} study materials (PDFs, ZIPs, TXTs)")


if __name__ == "__main__":
    main()
