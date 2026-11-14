"""Restore one deletion-trash entry into archive via the client worker.

Called by cli.handle through actions.ACTS; implementation is archive_service.
The active bot workspace, credentials and native session are not targets.
"""
from archive_service import restore


def act_restore(source, req, progress):
    progress('restore')
    return restore(req['params']['archive'])
