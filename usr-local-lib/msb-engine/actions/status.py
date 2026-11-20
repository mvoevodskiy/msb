from state import compute_state, write_state


def act_status(source, req, progress):
    write_state(compute_state())
    return {"ok": True}
