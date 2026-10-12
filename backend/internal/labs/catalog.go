package labs

import "encoding/json"

// Curated definitions copied as inert literals from the legacy allowlisted catalog.
// Grader execution is deliberately outside this package's workspace core.
type Definition struct {
	Slug      string `json:"slug"`
	Title     string `json:"title"`
	Type      string `json:"type"`
	Objective string `json:"objective"`
	Filename  string `json:"filename"`
	Starter   string `json:"starter,omitempty"`
	Tip       string `json:"tip"`
	Category  string `json:"category,omitempty"`
	Level     string `json:"level,omitempty"`
}

const GraderVersion = "courseforge-curated-v1"
const catalogJSON = "[{\"slug\":\"python-log-analysis\",\"title\":\"Python: detect production errors\",\"type\":\"docker\",\"objective\":\"Implement count_errors(lines) to count lines with log level ERROR, not WARNING.\",\"filename\":\"solution.py\",\"starter\":\"def count_errors(lines: list[str]) -> int:\\n    \\\"\\\"\\\"Count log records containing the severity token ERROR.\\\"\\\"\\\"\\n    # TODO: return the number of error records\\n    return 0\\n\",\"tip\":\"Use the log level token instead of matching words such as error_count.\"},{\"slug\":\"shell-http-analysis\",\"title\":\"Shell: inspect HTTP access logs\",\"type\":\"docker\",\"objective\":\"Write a POSIX shell script that counts HTTP 5xx responses from stdin; output one integer.\",\"filename\":\"solution.sh\",\"starter\":\"#!/bin/sh\\n# Input: space-separated `method path status` on stdin\\n# Print a single count for status codes 500-599\\necho 0\\n\",\"tip\":\"awk can read status code from column 3.\"},{\"slug\":\"k8s-resilient-service\",\"title\":\"Kubernetes: resilient API deployment\",\"type\":\"kubernetes\",\"objective\":\"Create a Deployment and Service YAML. The Deployment must be named learning-api, have 2 replicas, label app=learning-api, a readinessProbe and resource requests/limits. The ClusterIP Service must be named learning-api and target port 8080.\",\"filename\":\"manifest.yaml\",\"starter\":\"apiVersion: apps/v1\\nkind: Deployment\\nmetadata:\\n  name: learning-api\\nspec:\\n  replicas: 1\\n  selector:\\n    matchLabels:\\n      app: learning-api\\n  template:\\n    metadata:\\n      labels:\\n        app: learning-api\\n    spec:\\n      containers:\\n        - name: api\\n          image: nginx:1.27-alpine\\n          ports:\\n            - containerPort: 8080\\n---\\napiVersion: v1\\nkind: Service\\nmetadata:\\n  name: learning-api\\nspec:\\n  type: ClusterIP\\n  selector:\\n    app: learning-api\\n  ports:\\n    - port: 80\\n      targetPort: 8080\\n\",\"tip\":\"Add readinessProbe, resource requests/limits, and ensure 2 replicas.\"},{\"slug\":\"sql-customer-revenue\",\"title\":\"SQL: revenue per customer\",\"type\":\"sql\",\"category\":\"SQL\",\"level\":\"Intermediate\",\"objective\":\"Write a SQLite SELECT returning customer_name and total_revenue for paid orders, grouped by customer and sorted by total_revenue descending.\",\"filename\":\"solution.sql\",\"starter\":\"-- Tables: customers(id,name), orders(id,customer_id,amount,status)\\nSELECT name AS customer_name, 0 AS total_revenue FROM customers;\\n\",\"tip\":\"Join customers and orders, filter paid rows, GROUP BY customer, ORDER BY revenue descending.\"},{\"slug\":\"pyspark-order-analytics\",\"title\":\"PySpark: paid revenue by customer\",\"type\":\"pyspark\",\"category\":\"PySpark\",\"level\":\"Intermediate\",\"objective\":\"Implement summarize_paid_orders(df): filter paid rows, aggregate amount into total_revenue by customer_id and order by customer_id.\",\"filename\":\"solution.py\",\"starter\":\"from pyspark.sql import functions as F\\n\\ndef summarize_paid_orders(df):\\n    return df\\n\",\"tip\":\"Use filter, groupBy, sum, alias and orderBy.\"},{\"slug\":\"docker-hardened-service\",\"title\":\"Docker: hardened application image\",\"type\":\"static\",\"category\":\"Docker\",\"level\":\"Beginner\",\"objective\":\"Write a Dockerfile with pinned nginx:1.27-alpine, USER non-root, EXPOSE 8080 and HEALTHCHECK. Static checks only; Dockerfiles are not built.\",\"filename\":\"Dockerfile\",\"starter\":\"FROM nginx:1.27-alpine\\n# Add USER, EXPOSE and HEALTHCHECK\\n\",\"tip\":\"A non-root USER is required. No Docker socket or cloud credentials are available.\"},{\"slug\":\"ansible-idempotent-web\",\"title\":\"Ansible: idempotent web service\",\"type\":\"static\",\"category\":\"Ansible\",\"level\":\"Intermediate\",\"objective\":\"Write one play for web hosts with become: true. Use ansible.builtin.package to install nginx and ansible.builtin.service to start and enable it. No shell/command tasks.\",\"filename\":\"playbook.yml\",\"starter\":\"---\\n- name: Configure nginx\\n  hosts: web\\n  become: true\\n  tasks: []\\n\",\"tip\":\"Prefer declarative package and service tasks. Only offline YAML checks are performed.\"},{\"slug\":\"backend-request-handler\",\"title\":\"Backend: validate API requests\",\"type\":\"docker\",\"category\":\"Backend\",\"level\":\"Intermediate\",\"objective\":\"Implement handle_request(method,path,payload): GET /health => (200,{status:ok}); POST /tasks accepts a nonblank title => 201 with trimmed title, otherwise 400; unknown routes => 404.\",\"filename\":\"solution.py\",\"starter\":\"def handle_request(method, path, payload):\\n    return 404, {\\\"error\\\": \\\"not found\\\"}\\n\",\"tip\":\"Check for missing payload, invalid title types and leading whitespace.\"}]"

var definitions = func() map[string]Definition {
	var values []Definition
	if err := json.Unmarshal([]byte(catalogJSON), &values); err != nil {
		panic(err)
	}
	result := make(map[string]Definition, len(values))
	for _, value := range values {
		result[value.Slug] = value
	}
	return result
}()
