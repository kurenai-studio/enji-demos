# Splits a CDP Runtime.evaluate result whose value is newline-separated data URLs into numbered JPEGs.
# python3 tools/grab_all.py <cdp-result.json> <prefix>
import base64, json, sys

value = json.load(open(sys.argv[1]))['result']['value'].split('\n')
n = 0
for line in value:
    if line.startswith('data:'):
        open(f'{sys.argv[2]}{n}.jpg', 'wb').write(base64.b64decode(line.split(',', 1)[1]))
        n += 1
    else:
        print(line[:400])
print(n, 'images')
