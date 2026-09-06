#!/bin/bash
# 验证 matplotlib 产物收集
set -u
cat > /tmp/plot_req.json <<'EOF'
{"code":"import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nimport numpy as np\nx = np.linspace(0, 10, 100)\nplt.plot(x, np.sin(x))\nplt.title('sin wave')\nplt.savefig('sin.png')\nprint('saved')\n"}
EOF
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ccnu_lesson_agent-codex-1)
echo "codex ip: $IP"
curl -sS -X POST "http://$IP:9090/exec" -H 'Content-Type: application/json' \
  --data-binary @/tmp/plot_req.json | head -c 600
echo
