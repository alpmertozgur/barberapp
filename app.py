"""
BarberApp - 3-Tier Cloud Application Entrypoint (Python / Flask)
Serves:
  - Presentation tier static PWA files from ./public
  - Health check endpoint: GET /health
  - Action API (POST /api) for the existing frontend client
  - RESTful CRUD endpoints (/api/barbers, /api/services, /api/expenses, /api/payouts)
"""

import logging
import os

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()

from db import check_db, ensure_db_initialized
import store

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder="public", static_url_path="")

PUBLIC_ACTIONS = {
    "login": store.login,
    "registerAdmin": store.register_admin,
    "resetPassword": store.reset_password,
}

PRIVATE_ACTIONS = {
    "getData": lambda session, _params: store.get_data(session),
    "addBarber": store.add_barber,
    "updateBarber": store.update_barber,
    "deleteBarber": lambda session, params: store.delete_barber(session, str(params.get("id") or "")),
    "addService": store.add_service,
    "updateService": store.update_service,
    "deleteService": lambda session, params: store.delete_service(session, str(params.get("id") or "")),
    "addExpense": store.add_expense,
    "updateExpense": store.update_expense,
    "deleteExpense": lambda session, params: store.delete_expense(session, str(params.get("id") or "")),
    "addPayout": store.add_payout,
    "deletePayout": lambda session, params: store.delete_payout(session, str(params.get("id") or "")),
    "changeAdminPassword": store.change_admin_password,
}


def _json_body() -> dict:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _require_session() -> dict:
    return store.authenticate_bearer_header(request.headers.get("Authorization", ""))


@app.errorhandler(store.ApiError)
def handle_api_error(err: store.ApiError):
    return jsonify({"error": err.code}), err.status


@app.errorhandler(Exception)
def handle_unexpected_error(err: Exception):
    logger.exception("Unhandled server error: %s", err)
    if request.path.startswith("/api") or request.path == "/health":
        return jsonify({"error": "server_error"}), 500
    return "Internal Server Error", 500


@app.after_request
def set_cache_headers(response):
    if request.path == "/sw.js":
        response.headers["Cache-Control"] = "no-cache"
    elif request.path.startswith("/api") or request.path == "/health":
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def serve_index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/health")
def health_check():
    ok, reason = check_db()
    if ok:
        return jsonify({"status": "ok", "db": "connected"}), 200
    return jsonify({"status": "error", "db": reason or "disconnected"}), 503


# === ACTION-BASED ENDPOINT (Frontend Compatibility) ===


@app.post("/api")
def action_api():
    body = _json_body()
    action = body.get("action")
    params = {k: v for k, v in body.items() if k != "action"}

    if action in PUBLIC_ACTIONS:
        return jsonify(PUBLIC_ACTIONS[action](params)), 200

    if action in PRIVATE_ACTIONS:
        session = _require_session()
        return jsonify(PRIVATE_ACTIONS[action](session, params)), 200

    raise store.ApiError(400, "unknown_action")


# === RESTFUL CRUD ENDPOINTS ===


@app.post("/api/auth/login")
def rest_login():
    return jsonify(store.login(_json_body())), 200


@app.post("/api/auth/register-admin")
def rest_register_admin():
    return jsonify(store.register_admin(_json_body())), 201


@app.post("/api/auth/reset-password")
def rest_reset_password():
    return jsonify(store.reset_password(_json_body())), 200


@app.put("/api/auth/password")
def rest_change_admin_password():
    session = _require_session()
    return jsonify(store.change_admin_password(session, _json_body())), 200


@app.get("/api/dashboard")
def rest_dashboard():
    session = _require_session()
    return jsonify(store.get_data(session)), 200


@app.route("/api/barbers", methods=["GET", "POST"])
def rest_barbers():
    session = _require_session()
    if request.method == "GET":
        return jsonify({"barbers": store.list_barbers(session)}), 200
    return jsonify(store.add_barber(session, _json_body())), 201


@app.route("/api/barbers/<barber_id>", methods=["GET", "PUT", "PATCH", "DELETE"])
def rest_barber_detail(barber_id: str):
    session = _require_session()
    if request.method == "GET":
        return jsonify({"barber": store.get_barber_item(session, barber_id)}), 200
    if request.method in ("PUT", "PATCH"):
        return jsonify(store.update_barber(session, {**_json_body(), "id": barber_id})), 200
    return jsonify(store.delete_barber(session, barber_id)), 200


@app.route("/api/services", methods=["GET", "POST"])
def rest_services():
    session = _require_session()
    if request.method == "GET":
        barber_filter = request.args.get("barberId")
        return jsonify({"services": store.list_services(session, barber_filter)}), 200
    return jsonify(store.add_service(session, _json_body())), 201


@app.route("/api/services/<service_id>", methods=["GET", "PUT", "PATCH", "DELETE"])
def rest_service_detail(service_id: str):
    session = _require_session()
    if request.method == "GET":
        return jsonify({"service": store.get_service_item(session, service_id)}), 200
    if request.method in ("PUT", "PATCH"):
        return jsonify(store.update_service(session, {**_json_body(), "id": service_id})), 200
    return jsonify(store.delete_service(session, service_id)), 200


@app.route("/api/expenses", methods=["GET", "POST"])
def rest_expenses():
    session = _require_session()
    if request.method == "GET":
        return jsonify({"expenses": store.list_expenses(session)}), 200
    return jsonify(store.add_expense(session, _json_body())), 201


@app.route("/api/expenses/<expense_id>", methods=["GET", "PUT", "PATCH", "DELETE"])
def rest_expense_detail(expense_id: str):
    session = _require_session()
    if request.method == "GET":
        return jsonify({"expense": store.get_expense_item(session, expense_id)}), 200
    if request.method in ("PUT", "PATCH"):
        return jsonify(store.update_expense(session, {**_json_body(), "id": expense_id})), 200
    return jsonify(store.delete_expense(session, expense_id)), 200


@app.route("/api/payouts", methods=["GET", "POST"])
def rest_payouts():
    session = _require_session()
    if request.method == "GET":
        barber_filter = request.args.get("barberId")
        return jsonify({"payouts": store.list_payouts(session, barber_filter)}), 200
    return jsonify(store.add_payout(session, _json_body())), 201


@app.delete("/api/payouts/<payout_id>")
def rest_payout_detail(payout_id: str):
    session = _require_session()
    return jsonify(store.delete_payout(session, payout_id)), 200


if __name__ == "__main__":
    try:
        ensure_db_initialized()
    except Exception as exc:
        logger.warning("Database not ready on startup (%s); will initialize lazily.", exc)

    port = int(os.environ.get("PORT", "5000"))
    debug = os.environ.get("FLASK_DEBUG") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
