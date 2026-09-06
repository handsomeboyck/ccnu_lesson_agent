#!/bin/bash
set -u
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ccnu_lesson_agent-codex-1)
echo "codex ip: $IP"
cat > /tmp/plot_req.json <<'EOF'
{"code":"import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nimport numpy as np\nx = np.linspace(0,10,100)\nplt.plot(x,np.sin(x))\nplt.savefig('/out/sin.png')\nprint('OK saved')\nprint('cwd files:')\nimport os\nprint(os.listdir('/out'))\n"}
EOF
curl -sS -X POST "http://$IP:9090/exec" -H 'Content-Type: application/json' \
  --data-binary @/tmp/plot_req.json
echo
