"""Convert TbotAI.onnx (scikit-learn MLP exported by train.py) into the JSON
weights the web bot loads (public/model/tbotai-model.json).

Usage: python export_web_model.py TbotAI.onnx ../../public/model/tbotai-model.json
"""
import json, sys
import numpy as np
import onnx
from onnx import numpy_helper


def convert(onnx_path: str) -> dict:
    m = onnx.load(onnx_path)
    inits = {i.name: numpy_helper.to_array(i) for i in m.graph.initializer}
    model = {"format": "tbot-mlp-v1", "classes": ["down", "none", "up"], "layers": []}
    for node in m.graph.node:
        if node.op_type == "Scaler":
            attrs = {a.name: list(a.floats) for a in node.attribute}
            model["offset"], model["scale"] = attrs["offset"], attrs["scale"]
        elif node.op_type == "MatMul":
            W = inits[node.input[1]]
            model["layers"].append({"in": int(W.shape[0]), "out": int(W.shape[1]),
                                    "W": [float(v) for v in W.reshape(-1)], "b": None})
        elif node.op_type == "Add" and model["layers"] and model["layers"][-1]["b"] is None:
            b = next(inits[n] for n in node.input if n in inits)
            model["layers"][-1]["b"] = [float(v) for v in np.ravel(b)]
    assert "offset" in model and model["layers"] and all(L["b"] for L in model["layers"]), "unexpected ONNX layout"
    return model


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "TbotAI.onnx"
    dst = sys.argv[2] if len(sys.argv) > 2 else "tbotai-model.json"
    model = convert(src)
    cfg_path = src.replace(".onnx", "_config.json")
    try:
        cfg = json.load(open(cfg_path))
        model["trained_from"], model["trained_to"] = cfg.get("trained_from"), cfg.get("trained_to")
        model["barrier_atr"], model["horizon_bars"] = cfg.get("barrier_atr"), cfg.get("horizon_bars")
        model["suggested_threshold"] = cfg.get("suggested_threshold")
        model["walk_forward"] = cfg.get("walk_forward")
    except FileNotFoundError:
        pass
    json.dump(model, open(dst, "w"))
    print(f"wrote {dst}: layers {[(L['in'], L['out']) for L in model['layers']]}")
