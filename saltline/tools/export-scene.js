/* Dumps the live Saltline Three scene to a glTF the Enji preview can import. */
(async function dumpSaltline() {
    const HOST = "http://127.0.0.1:8777";
    const G = window.__G;
    const THREE = G.THREE;
    const renderer = G.renderer;
    const gl = renderer.getContext();
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:99999;background:#111;color:#eee;font:14px/1.4 monospace;padding:10px 14px;max-width:640px";
    document.body.appendChild(box);
    const state = { phase: "init", mesh: 0, meshes: 0, tex: 0 };
    window.__dump = state;
    function say(phase, extra) {
        state.phase = phase;
        if (extra) Object.assign(state, extra);
        box.textContent = phase + "  " + JSON.stringify(extra || { mesh: state.mesh, meshes: state.meshes, tex: state.tex });
    }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function upload(path, bytes, append) {
        const body = bytes instanceof Blob ? bytes : new Blob([bytes]);
        const res = await fetch(HOST + "/upload", {
            method: "POST",
            headers: { "X-Path": path, "X-Append": append ? "1" : "0" },
            body,
        });
        if (!res.ok && res.status !== 204) throw new Error("upload " + path + " " + res.status);
    }

    const savedRender = renderer.render.bind(renderer);
    const savedRaf = window.requestAnimationFrame;
    renderer.render = function () {};
    window.requestAnimationFrame = function () { return 0; };

    try {
        G.scene.updateMatrixWorld(true);
        const meshes = [];
        G.scene.traverse((obj) => {
            if (!obj.isMesh || !obj.visible) return;
            let parent = obj;
            while (parent) {
                if (parent.visible === false) return;
                parent = parent.parent;
            }
            const list = Array.isArray(obj.material) ? obj.material : [obj.material];
            if (list.every((mat) => !mat || mat.isShaderMaterial)) return;
            meshes.push(obj);
        });
        say("meshes", { meshes: meshes.length, mesh: 0, tex: 0 });

        const images = [];
        const textures = [];
        const materials = [];
        const gltfMeshes = [];
        const nodes = [];
        const accessors = [];
        const bufferViews = [];
        const binParts = [];
        let binLength = 0;
        const imageCache = new Map();
        const materialCache = new Map();
        let extensionsUsed = [];

        function align(n) {
            const pad = (n - (binLength % n)) % n;
            if (pad) {
                binParts.push(new Uint8Array(pad));
                binLength += pad;
            }
        }
        function pushView(bytes) {
            align(4);
            const view = bufferViews.length;
            bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength });
            binParts.push(bytes);
            binLength += bytes.byteLength;
            return view;
        }
        function addAccessor(view, componentType, type, count, min, max) {
            const acc = { bufferView: view, componentType, count, type };
            if (min) acc.min = min;
            if (max) acc.max = max;
            accessors.push(acc);
            return accessors.length - 1;
        }
        function srgbToLin(byte) {
            const c = byte / 255;
            return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }
        function linToByte(c) {
            const x = Math.min(1, Math.max(0, c));
            const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
            return Math.round(Math.min(1, Math.max(0, s)) * 255);
        }
        function linToSrgbUnit(c) {
            const x = Math.max(0, c);
            return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
        }
        function nearWhite(color) {
            return color && color.r > 0.98 && color.g > 0.98 && color.b > 0.98;
        }

        function pixelsOf(tex) {
            const img = tex.image;
            const w = img && img.width;
            const h = img && img.height;
            if (!w || !h) throw new Error("texture has no size");
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (img instanceof HTMLCanvasElement || img instanceof HTMLImageElement) {
                if (tex.flipY) {
                    ctx.translate(0, h);
                    ctx.scale(1, -1);
                }
                ctx.drawImage(img, 0, 0, w, h);
                return { canvas, w, h };
            }
            const props = renderer.properties.get(tex);
            const gpu = props && props.__webglTexture;
            if (!gpu) throw new Error("texture is not on the GPU");
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gpu, 0);
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            if (status !== gl.FRAMEBUFFER_COMPLETE) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                gl.deleteFramebuffer(fb);
                throw new Error("framebuffer " + status);
            }
            const buf = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fb);
            const image = ctx.createImageData(w, h);
            if (tex.flipY) {
                const row = w * 4;
                for (let y = 0; y < h; y++) {
                    image.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
                }
            } else {
                image.data.set(buf);
            }
            ctx.putImageData(image, 0, 0);
            return { canvas, w, h };
        }

        function bakeTint(canvas, mat) {
            const tint = mat.defines && mat.defines.SL_TINT;
            const needs = tint === 1 || tint === 2 || ((tint === 3 || tint === 0 || tint == null) && mat.color && !nearWhite(mat.color));
            if (!needs || !mat.color) return canvas;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = image.data;
            const cr = mat.color.r;
            const cg = mat.color.g;
            const cb = mat.color.b;
            const opaque = !mat.transparent && !(mat.alphaTest > 0);
            for (let i = 0; i < data.length; i += 4) {
                const mr = srgbToLin(data[i]);
                const mg = srgbToLin(data[i + 1]);
                const mb = srgbToLin(data[i + 2]);
                const a = data[i + 3] / 255;
                let r;
                let g;
                let b;
                if (tint === 1) {
                    r = mr + cr * a;
                    g = mg + cg * a;
                    b = mb + cb * a;
                } else if (tint === 2) {
                    const L = Math.min(1.35, Math.max(0.55, (mr + mg + mb) / 3 / 0.19));
                    const t = a * 0.96;
                    r = mr * (1 - t) + cr * L * t;
                    g = mg * (1 - t) + cg * L * t;
                    b = mb * (1 - t) + cb * L * t;
                } else {
                    r = mr * cr;
                    g = mg * cg;
                    b = mb * cb;
                }
                data[i] = linToByte(r);
                data[i + 1] = linToByte(g);
                data[i + 2] = linToByte(b);
                if (opaque) data[i + 3] = 255;
            }
            ctx.putImageData(image, 0, 0);
            return canvas;
        }

        function pngOf(canvas) {
            return new Promise((resolve, reject) => {
                canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png encode failed"))), "image/png");
            });
        }

        async function imageIndex(tex, mat, bake) {
            const tint = bake && mat && mat.defines ? mat.defines.SL_TINT : "raw";
            const color = bake && mat && mat.color ? mat.color.getHexString() : "";
            const key = tex.uuid + "|" + tint + "|" + color + "|" + (bake ? "b" : "r");
            if (imageCache.has(key)) return imageCache.get(key);
            say("texture", { tex: state.tex, mesh: state.mesh, meshes: meshes.length, key: (mat && mat.name) || key.slice(0, 8) });
            const shot = pixelsOf(tex);
            if (bake) bakeTint(shot.canvas, mat);
            const png = await pngOf(shot.canvas);
            const name = "tex/" + images.length + ".png";
            await upload(name, png, false);
            const index = images.length;
            images.push({ uri: name });
            textures.push({ source: index, sampler: 0 });
            imageCache.set(key, textures.length - 1);
            state.tex += 1;
            return textures.length - 1;
        }

        async function gltfMaterial(mat) {
            if (materialCache.has(mat.uuid)) return materialCache.get(mat.uuid);
            const gltfMat = { name: (mat.name || "mat") + "_" + materials.length, pbrMetallicRoughness: {} };
            const pbr = gltfMat.pbrMetallicRoughness;
            if (mat.isMeshBasicMaterial) {
                gltfMat.extensions = { KHR_materials_unlit: {} };
                if (!extensionsUsed.includes("KHR_materials_unlit")) extensionsUsed.push("KHR_materials_unlit");
                const c = mat.color || { r: 1, g: 1, b: 1 };
                pbr.baseColorFactor = [c.r, c.g, c.b, mat.opacity == null ? 1 : mat.opacity];
                pbr.metallicFactor = 0;
                pbr.roughnessFactor = 1;
                if (mat.map) pbr.baseColorTexture = { index: await imageIndex(mat.map, mat, false) };
            } else {
                const tint = mat.defines && mat.defines.SL_TINT;
                const bake = !!mat.map && (tint === 1 || tint === 2 || ((tint === 0 || tint === 3 || tint == null) && mat.color && !nearWhite(mat.color)));
                if (mat.map) {
                    pbr.baseColorTexture = { index: await imageIndex(mat.map, mat, bake) };
                    pbr.baseColorFactor = [1, 1, 1, 1];
                } else if (mat.color) {
                    pbr.baseColorFactor = [mat.color.r, mat.color.g, mat.color.b, 1];
                }
                const orm = mat.roughnessMap || mat.metalnessMap || mat.aoMap;
                if (orm) {
                    const index = await imageIndex(orm, mat, false);
                    pbr.metallicRoughnessTexture = { index };
                    gltfMat.occlusionTexture = { index, strength: 1 };
                }
                pbr.metallicFactor = mat.metalness == null ? 0 : mat.metalness;
                pbr.roughnessFactor = mat.roughness == null ? 1 : mat.roughness;
                if (mat.normalMap) {
                    gltfMat.normalTexture = { index: await imageIndex(mat.normalMap, mat, false) };
                    if (mat.normalScale && Math.abs(mat.normalScale.x - 1) > 0.001) gltfMat.normalTexture.scale = mat.normalScale.x;
                }
                if (mat.emissive && mat.emissive.r + mat.emissive.g + mat.emissive.b > 0.001) {
                    const gain = mat.emissiveIntensity == null ? 1 : mat.emissiveIntensity;
                    gltfMat.emissiveFactor = [mat.emissive.r * gain, mat.emissive.g * gain, mat.emissive.b * gain];
                }
            }
            if (mat.side && mat.side !== 0) gltfMat.doubleSided = true;
            if (mat.alphaTest > 0) {
                gltfMat.alphaMode = "MASK";
                gltfMat.alphaCutoff = mat.alphaTest;
            } else if (mat.transparent) {
                gltfMat.alphaMode = "BLEND";
            }
            const index = materials.length;
            materials.push(gltfMat);
            materialCache.set(mat.uuid, index);
            return index;
        }

        function uvElements(mat) {
            const tex = mat && (mat.map || mat.normalMap || mat.roughnessMap);
            if (!tex) return null;
            tex.updateMatrix();
            const e = tex.matrix.elements;
            const identity = Math.abs(e[0] - 1) < 1e-5 && Math.abs(e[4] - 1) < 1e-5 && Math.abs(e[1]) < 1e-5 && Math.abs(e[3]) < 1e-5 && Math.abs(e[6]) < 1e-5 && Math.abs(e[7]) < 1e-5;
            return identity ? null : e;
        }

        function boneNormalMatrices(mesh) {
            const bones = mesh.skeleton.bones;
            const inverses = mesh.skeleton.boneInverses;
            const out = [];
            const m = new THREE.Matrix4();
            for (let i = 0; i < bones.length; i++) {
                m.multiplyMatrices(bones[i].matrixWorld, inverses[i]);
                out.push(new THREE.Matrix3().getNormalMatrix(m));
            }
            return {
                bones: out,
                bind: new THREE.Matrix3().getNormalMatrix(mesh.bindMatrix),
                bindInv: new THREE.Matrix3().getNormalMatrix(mesh.bindMatrixInverse),
            };
        }
        function applyNormal(m, x, y, z, target) {
            const e = m.elements;
            target.x = e[0] * x + e[3] * y + e[6] * z;
            target.y = e[1] * x + e[4] * y + e[7] * z;
            target.z = e[2] * x + e[5] * y + e[8] * z;
        }

        const v = new THREE.Vector3();
        const n = new THREE.Vector3();
        const tmp = new THREE.Vector3();
        const bounds = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] };

        for (let mi = 0; mi < meshes.length; mi++) {
            const mesh = meshes[mi];
            state.mesh = mi;
            if (mi % 4 === 0) {
                say("geometry", { mesh: mi, meshes: meshes.length, tex: state.tex });
                await sleep(0);
            }
            const geo = mesh.geometry;
            const posAttr = geo.attributes.position;
            if (!posAttr) continue;
            const nrmAttr = geo.attributes.normal;
            const uvAttr = geo.attributes.uv;
            const colAttr = geo.attributes.color;
            const count = posAttr.count;
            const skinned = !!mesh.isSkinnedMesh;
            if (skinned && mesh.skeleton) mesh.skeleton.update();
            const skinN = skinned ? boneNormalMatrices(mesh) : null;
            const skinIndex = skinned && geo.attributes.skinIndex;
            const skinWeight = skinned && geo.attributes.skinWeight;
            const worldN = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
            const positions = new Float32Array(count * 3);
            const normals = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                v.fromBufferAttribute(posAttr, i);
                if (skinned) mesh.applyBoneTransform(i, v);
                v.applyMatrix4(mesh.matrixWorld);
                positions[i * 3] = v.x;
                positions[i * 3 + 1] = v.y;
                positions[i * 3 + 2] = v.z;
                if (v.x < bounds.min[0]) bounds.min[0] = v.x;
                if (v.y < bounds.min[1]) bounds.min[1] = v.y;
                if (v.z < bounds.min[2]) bounds.min[2] = v.z;
                if (v.x > bounds.max[0]) bounds.max[0] = v.x;
                if (v.y > bounds.max[1]) bounds.max[1] = v.y;
                if (v.z > bounds.max[2]) bounds.max[2] = v.z;
                if (nrmAttr) n.fromBufferAttribute(nrmAttr, i);
                else n.set(0, 1, 0);
                if (skinN && skinIndex && skinWeight) {
                    applyNormal(skinN.bind, n.x, n.y, n.z, tmp);
                    const weights = [skinWeight.getX(i), skinWeight.getY(i), skinWeight.getZ(i), skinWeight.getW(i)];
                    const bones = [skinIndex.getX(i), skinIndex.getY(i), skinIndex.getZ(i), skinIndex.getW(i)];
                    let x = 0;
                    let y = 0;
                    let z = 0;
                    for (let k = 0; k < 4; k++) {
                        const w = weights[k];
                        if (!w) continue;
                        const bn = skinN.bones[bones[k] | 0];
                        if (!bn) continue;
                        applyNormal(bn, tmp.x, tmp.y, tmp.z, v);
                        x += v.x * w;
                        y += v.y * w;
                        z += v.z * w;
                    }
                    applyNormal(skinN.bindInv, x, y, z, n);
                }
                applyNormal(worldN, n.x, n.y, n.z, n);
                const len = Math.hypot(n.x, n.y, n.z) || 1;
                normals[i * 3] = n.x / len;
                normals[i * 3 + 1] = n.y / len;
                normals[i * 3 + 2] = n.z / len;
            }
            const srcIndex = geo.index ? geo.index.array : null;
            const groups = geo.groups && geo.groups.length ? geo.groups : [{ start: 0, count: srcIndex ? srcIndex.length : count, materialIndex: 0 }];
            const matList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const primitives = [];
            for (const group of groups) {
                const mat = matList[group.materialIndex] || matList[0];
                if (!mat || mat.isShaderMaterial) continue;
                const indexCount = group.count;
                if (!indexCount) continue;
                const raw = new Uint32Array(indexCount);
                for (let i = 0; i < indexCount; i++) raw[i] = srcIndex ? srcIndex[group.start + i] : group.start + i;
                const remap = new Int32Array(count);
                remap.fill(-1);
                let used = 0;
                for (let i = 0; i < indexCount; i++) {
                    const vi = raw[i];
                    if (remap[vi] === -1) remap[vi] = used++;
                }
                const ip = new Float32Array(used * 3);
                const ir = new Float32Array(used * 3);
                const iu = new Float32Array(used * 2);
                const ic = colAttr ? new Float32Array(used * 4) : null;
                const xf = uvElements(mat);
                for (let vi = 0; vi < count; vi++) {
                    const ni = remap[vi];
                    if (ni < 0) continue;
                    ip[ni * 3] = positions[vi * 3];
                    ip[ni * 3 + 1] = positions[vi * 3 + 1];
                    ip[ni * 3 + 2] = positions[vi * 3 + 2];
                    ir[ni * 3] = normals[vi * 3];
                    ir[ni * 3 + 1] = normals[vi * 3 + 1];
                    ir[ni * 3 + 2] = normals[vi * 3 + 2];
                    let u = uvAttr ? uvAttr.getX(vi) : 0;
                    let tv = uvAttr ? uvAttr.getY(vi) : 0;
                    if (xf) {
                        const uu = xf[0] * u + xf[3] * tv + xf[6];
                        const vv = xf[1] * u + xf[4] * tv + xf[7];
                        u = uu;
                        tv = vv;
                    }
                    iu[ni * 2] = u;
                    iu[ni * 2 + 1] = tv;
                    if (ic) {
                        const r = colAttr.getX(vi);
                        const g = colAttr.itemSize > 1 ? colAttr.getY(vi) : r;
                        const b = colAttr.itemSize > 2 ? colAttr.getZ(vi) : r;
                        const a = colAttr.itemSize > 3 ? colAttr.getW(vi) : 1;
                        ic[ni * 4] = linToSrgbUnit(r);
                        ic[ni * 4 + 1] = linToSrgbUnit(g);
                        ic[ni * 4 + 2] = linToSrgbUnit(b);
                        ic[ni * 4 + 3] = a;
                    }
                }
                const packed = new Uint32Array(indexCount);
                for (let i = 0; i < indexCount; i++) packed[i] = remap[raw[i]];
                const tan = new Float32Array(used * 4);
                const t1x = new Float32Array(used);
                const t1y = new Float32Array(used);
                const t1z = new Float32Array(used);
                const t2x = new Float32Array(used);
                const t2y = new Float32Array(used);
                const t2z = new Float32Array(used);
                for (let i = 0; i + 2 < indexCount; i += 3) {
                    const i0 = packed[i];
                    const i1 = packed[i + 1];
                    const i2 = packed[i + 2];
                    const x0 = ip[i0 * 3], y0 = ip[i0 * 3 + 1], z0 = ip[i0 * 3 + 2];
                    const x1 = ip[i1 * 3] - x0, y1 = ip[i1 * 3 + 1] - y0, z1 = ip[i1 * 3 + 2] - z0;
                    const x2 = ip[i2 * 3] - x0, y2 = ip[i2 * 3 + 1] - y0, z2 = ip[i2 * 3 + 2] - z0;
                    const s1 = iu[i1 * 2] - iu[i0 * 2];
                    const s2 = iu[i2 * 2] - iu[i0 * 2];
                    const tt1 = iu[i1 * 2 + 1] - iu[i0 * 2 + 1];
                    const tt2 = iu[i2 * 2 + 1] - iu[i0 * 2 + 1];
                    const denom = s1 * tt2 - s2 * tt1;
                    if (Math.abs(denom) < 1e-12) continue;
                    const f = 1 / denom;
                    const sx = f * (tt2 * x1 - tt1 * x2);
                    const sy = f * (tt2 * y1 - tt1 * y2);
                    const sz = f * (tt2 * z1 - tt1 * z2);
                    const tx = f * (s1 * x2 - s2 * x1);
                    const ty = f * (s1 * y2 - s2 * y1);
                    const tz = f * (s1 * z2 - s2 * z1);
                    t1x[i0] += sx; t1y[i0] += sy; t1z[i0] += sz; t2x[i0] += tx; t2y[i0] += ty; t2z[i0] += tz;
                    t1x[i1] += sx; t1y[i1] += sy; t1z[i1] += sz; t2x[i1] += tx; t2y[i1] += ty; t2z[i1] += tz;
                    t1x[i2] += sx; t1y[i2] += sy; t1z[i2] += sz; t2x[i2] += tx; t2y[i2] += ty; t2z[i2] += tz;
                }
                for (let i = 0; i < used; i++) {
                    const nx = ir[i * 3], ny = ir[i * 3 + 1], nz = ir[i * 3 + 2];
                    let tx = t1x[i], ty = t1y[i], tz = t1z[i];
                    const d = nx * tx + ny * ty + nz * tz;
                    tx -= nx * d; ty -= ny * d; tz -= nz * d;
                    let tl = Math.hypot(tx, ty, tz);
                    if (tl < 1e-8) {
                        tx = 1; ty = 0; tz = 0;
                        const d2 = nx * tx + ny * ty + nz * tz;
                        tx -= nx * d2; ty -= ny * d2; tz -= nz * d2;
                        tl = Math.hypot(tx, ty, tz) || 1;
                    }
                    tx /= tl; ty /= tl; tz /= tl;
                    const cx = ny * tz - nz * ty;
                    const cy = nz * tx - nx * tz;
                    const cz = nx * ty - ny * tx;
                    const w = cx * t2x[i] + cy * t2y[i] + cz * t2z[i] < 0 ? -1 : 1;
                    tan[i * 4] = tx; tan[i * 4 + 1] = ty; tan[i * 4 + 2] = tz; tan[i * 4 + 3] = w;
                }
                let pmin = [ip[0], ip[1], ip[2]];
                let pmax = [ip[0], ip[1], ip[2]];
                for (let i = 1; i < used; i++) {
                    const x = ip[i * 3], y = ip[i * 3 + 1], z = ip[i * 3 + 2];
                    if (x < pmin[0]) pmin[0] = x; if (y < pmin[1]) pmin[1] = y; if (z < pmin[2]) pmin[2] = z;
                    if (x > pmax[0]) pmax[0] = x; if (y > pmax[1]) pmax[1] = y; if (z > pmax[2]) pmax[2] = z;
                }
                const prim = {
                    attributes: {
                        POSITION: addAccessor(pushView(ip), 5126, "VEC3", used, pmin, pmax),
                        NORMAL: addAccessor(pushView(ir), 5126, "VEC3", used),
                        TEXCOORD_0: addAccessor(pushView(iu), 5126, "VEC2", used),
                        TANGENT: addAccessor(pushView(tan), 5126, "VEC4", used),
                    },
                    indices: addAccessor(pushView(packed), 5125, "SCALAR", indexCount),
                    material: await gltfMaterial(mat),
                };
                if (ic) prim.attributes.COLOR_0 = addAccessor(pushView(ic), 5126, "VEC4", used);
                primitives.push(prim);
            }
            if (!primitives.length) continue;
            const meshIndex = gltfMeshes.length;
            gltfMeshes.push({ name: (mesh.parent && mesh.parent.name ? mesh.parent.name + "_" : "") + (mesh.name || "mesh") + "_" + mi, primitives });
            nodes.push({ mesh: meshIndex });
        }

        say("pack", { mesh: meshes.length, meshes: meshes.length, tex: state.tex, bin: binLength });
        const binBlob = new Blob(binParts);
        const chunk = 8 * 1024 * 1024;
        for (let offset = 0; offset < binBlob.size; offset += chunk) {
            say("upload-bin", { offset, size: binBlob.size, tex: state.tex });
            await upload("saltline.bin", binBlob.slice(offset, offset + chunk), offset > 0);
        }
        const cam = G.camera;
        const dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        const look = cam.position.clone().add(dir);
        const sun = G.scene.getObjectByName("sun");
        const sunTarget = new THREE.Vector3();
        if (sun && sun.target) sun.target.getWorldPosition(sunTarget);
        const points = [];
        G.scene.traverse((obj) => {
            if (!obj.isPointLight || !obj.visible || obj.intensity <= 0) return;
            const p = new THREE.Vector3();
            obj.getWorldPosition(p);
            points.push({ pos: p.toArray(), color: [obj.color.r, obj.color.g, obj.color.b], intensity: obj.intensity, distance: obj.distance || 0 });
        });
        const gltf = {
            asset: { version: "2.0", generator: "saltline-dump" },
            extensionsUsed,
            scene: 0,
            scenes: [{ name: "Saltline", nodes: nodes.map((_, i) => i) }],
            nodes,
            meshes: gltfMeshes,
            materials,
            textures,
            images,
            samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
            buffers: [{ uri: "saltline.bin", byteLength: binBlob.size }],
            bufferViews,
            accessors,
        };
        if (!extensionsUsed.length) delete gltf.extensionsUsed;
        const shot = {
            camera: { pos: cam.position.toArray(), look: look.toArray(), fov: cam.fov, near: cam.near, far: cam.far },
            path: (G.level && G.level.cinematicPath) || [],
            sun: sun ? { pos: sun.position.toArray(), target: sunTarget.toArray(), color: [sun.color.r, sun.color.g, sun.color.b], intensity: sun.intensity } : null,
            points,
            bounds,
        };
        await upload("saltline.gltf", new Blob([JSON.stringify(gltf)]), false);
        await upload("shot.json", new Blob([JSON.stringify(shot)]), false);
        say("done", { mesh: meshes.length, meshes: meshes.length, tex: state.tex, bin: binBlob.size, materials: materials.length });
    } catch (err) {
        state.phase = "error";
        state.error = String((err && err.stack) || err);
        box.textContent = state.error;
    } finally {
        renderer.render = savedRender;
        window.requestAnimationFrame = savedRaf;
    }
})();
