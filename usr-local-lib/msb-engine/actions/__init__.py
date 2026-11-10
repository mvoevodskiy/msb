from .bots import act_disable_jarvis, act_enable_jarvis
from .openclaw import act_disable_openclaw, act_enable_openclaw, act_update_openclaw
from .pult import act_disable_pult, act_enable_pult, act_reload_pult
from .status import act_status

ACTS = {
    "status": act_status,
    "enable-msb": act_enable_jarvis,
    "disable-msb": act_disable_jarvis,
    "enable-jarvis": act_enable_jarvis,
    "disable-jarvis": act_disable_jarvis,
    "enable-openclaw": act_enable_openclaw,
    "disable-openclaw": act_disable_openclaw,
    "update-openclaw": act_update_openclaw,
    "enable-pult": act_enable_pult,
    "disable-pult": act_disable_pult,
    "reload-pult": act_reload_pult,
}
