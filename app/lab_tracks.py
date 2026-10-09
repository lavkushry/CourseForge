"""Reviewed hands-on exercises; never execute untrusted course text on the host."""
TRACKS = {
 'sql-customer-revenue': {
  'title':'SQL: revenue per customer','type':'sql','category':'SQL','level':'Intermediate',
  'objective':'Write a SQLite SELECT returning customer_name and total_revenue for paid orders, grouped by customer and sorted by total_revenue descending.',
  'filename':'solution.sql','starter':"-- Tables: customers(id,name), orders(id,customer_id,amount,status)\nSELECT name AS customer_name, 0 AS total_revenue FROM customers;\n",
  'tip':'Join customers and orders, filter paid rows, GROUP BY customer, ORDER BY revenue descending.'
 },
 'pyspark-order-analytics': {
  'title':'PySpark: paid revenue by customer','type':'pyspark','category':'PySpark','level':'Intermediate',
  'objective':'Implement summarize_paid_orders(df): filter paid rows, aggregate amount into total_revenue by customer_id and order by customer_id.',
  'filename':'solution.py','starter':"from pyspark.sql import functions as F\n\ndef summarize_paid_orders(df):\n    return df\n",
  'tip':'Use filter, groupBy, sum, alias and orderBy.'
 },
 'docker-hardened-service': {
  'title':'Docker: hardened application image','type':'static','category':'Docker','level':'Beginner',
  'objective':'Write a Dockerfile with pinned nginx:1.27-alpine, USER non-root, EXPOSE 8080 and HEALTHCHECK. Static checks only; Dockerfiles are not built.',
  'filename':'Dockerfile','starter':'FROM nginx:1.27-alpine\n# Add USER, EXPOSE and HEALTHCHECK\n',
  'tip':'A non-root USER is required. No Docker socket or cloud credentials are available.'
 },
 'ansible-idempotent-web': {
  'title':'Ansible: idempotent web service','type':'static','category':'Ansible','level':'Intermediate',
  'objective':'Write one play for web hosts with become: true. Use ansible.builtin.package to install nginx and ansible.builtin.service to start and enable it. No shell/command tasks.',
  'filename':'playbook.yml','starter':'---\n- name: Configure nginx\n  hosts: web\n  become: true\n  tasks: []\n',
  'tip':'Prefer declarative package and service tasks. Only offline YAML checks are performed.'
 },
 'backend-request-handler': {
  'title':'Backend: validate API requests','type':'docker','category':'Backend','level':'Intermediate',
  'objective':'Implement handle_request(method,path,payload): GET /health => (200,{status:ok}); POST /tasks accepts a nonblank title => 201 with trimmed title, otherwise 400; unknown routes => 404.',
  'filename':'solution.py','starter':'def handle_request(method, path, payload):\n    return 404, {"error": "not found"}\n',
  'tip':'Check for missing payload, invalid title types and leading whitespace.'
 }
}
