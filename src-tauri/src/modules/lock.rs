//! Poison-tolerant lock helpers for shared state.
//!
//! A `Mutex`/`RwLock` becomes poisoned when a thread panics while holding
//! the guard. For process-wide registries (PTY sessions, shell sessions,
//! background processes) a poisoned lock would otherwise make every
//! subsequent command fail with an opaque panic. The data these locks
//! protect is just `HashMap` bookkeeping — never left half-mutated by the
//! panics we anticipate — so recovering the inner value is safe.

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub fn mutex_lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| {
        log::warn!("recovered poisoned mutex");
        e.into_inner()
    })
}

pub fn rwlock_read<T>(l: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|e| {
        log::warn!("recovered poisoned rwlock (read)");
        e.into_inner()
    })
}

pub fn rwlock_write<T>(l: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|e| {
        log::warn!("recovered poisoned rwlock (write)");
        e.into_inner()
    })
}
