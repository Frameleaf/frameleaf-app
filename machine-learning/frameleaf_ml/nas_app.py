"""Container API additions kept outside the immutable library preprocessing identity."""

from fastapi import File, Form, HTTPException

from . import main
from .face_producer_binding import FaceBoundPredictor
from .inference_executor import InferenceBusy
from .schemas import ORJSONResponse

app = main.app
producer = FaceBoundPredictor()


@app.post("/predict-face-bound")
async def predict_face_bound(binding: str = Form(), image: bytes = File()) -> ORJSONResponse:
    try:
        result = await main.run(producer.predict, binding, image, None)
    except InferenceBusy:
        raise
    except Exception as error:
        raise HTTPException(409, "face_model_identity_unavailable") from error
    return ORJSONResponse(result)
