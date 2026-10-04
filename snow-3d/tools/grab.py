# Decodes a canvas data URL saved by a CDP Runtime.evaluate result into an image file.
# python3 tools/grab.py <cdp-result.json|txt> <out.jpg>
import base64, json, re, sys

text = open(sys.argv[1]).read()
m = re.search(r'data:image/(?:jpeg|png);base64,([A-Za-z0-9+/=]+)', text)
if not m:
    sys.exit('no data URL in ' + sys.argv[1])
open(sys.argv[2], 'wb').write(base64.b64decode(m.group(1)))
print(sys.argv[2])
