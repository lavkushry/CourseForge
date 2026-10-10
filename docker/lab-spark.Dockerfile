FROM python:3.12.7-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir PyYAML==6.0.2 pyspark==3.5.9
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
 SPARK_LOCAL_IP=127.0.0.1 \
 SPARK_LOCAL_HOSTNAME=localhost \
 PYSPARK_PYTHON=python3
WORKDIR /workspace
