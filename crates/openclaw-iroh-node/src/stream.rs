//! Stream halves. Reads return a Buffer that owns the received bytes; writes copy the caller's
//! Buffer/Uint8Array once on the JS thread (so JS may reuse it immediately) and then await QUIC flow
//! control off-thread.

use std::sync::Arc;

use iroh::endpoint::{self, VarInt};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::{io::AsyncReadExt, sync::Mutex};

use crate::js_err;

/// Sending half of a bidirectional stream.
#[napi]
pub struct SendStream(Arc<Mutex<endpoint::SendStream>>);

impl SendStream {
    pub(crate) fn new(s: endpoint::SendStream) -> Self {
        Self(Arc::new(Mutex::new(s)))
    }
}

#[napi]
impl SendStream {
    /// Writes all bytes; resolves when QUIC has accepted them (flow-control backpressure).
    #[napi(ts_return_type = "Promise<void>")]
    pub fn write<'env>(&self, env: &'env Env, data: &[u8]) -> Result<PromiseRaw<'env, ()>> {
        let bytes = data.to_vec();
        let s = self.0.clone();
        env.spawn_future(async move {
            s.lock().await.write_all(&bytes).await.map_err(js_err)?;
            Ok(())
        })
    }

    /// Ends the send side cleanly (FIN).
    #[napi]
    pub async fn finish(&self) -> Result<()> {
        self.0.lock().await.finish().map_err(js_err)
    }

    /// Abandons the send side with an application error code.
    #[napi]
    pub async fn reset(&self, code: u32) -> Result<()> {
        self.0
            .lock()
            .await
            .reset(VarInt::from_u32(code))
            .map_err(js_err)
    }
}

/// Receiving half of a bidirectional stream.
#[napi]
pub struct RecvStream(Arc<Mutex<endpoint::RecvStream>>);

impl RecvStream {
    pub(crate) fn new(r: endpoint::RecvStream) -> Self {
        Self(Arc::new(Mutex::new(r)))
    }
}

#[napi]
impl RecvStream {
    /// Reads whatever is available (at least 1 byte, at most `max`), gathering every chunk QUIC has
    /// already received so one JS call covers many packets; resolves null at end of stream.
    /// Rejects if the peer reset the stream (message contains the reset code).
    #[napi]
    pub async fn read(&self, max: u32) -> Result<Option<Buffer>> {
        if max == 0 {
            return Err(js_err("max must be > 0"));
        }
        // read_buf fills spare capacity without zeroing it; 0 bytes read with room left means EOF.
        let mut buf = Vec::with_capacity(max as usize);
        let n = self
            .0
            .lock()
            .await
            .read_buf(&mut buf)
            .await
            .map_err(js_err)?;
        if n == 0 {
            return Ok(None);
        }
        // The Buffer keeps the Vec's allocation alive, so drop unused capacity first.
        buf.shrink_to_fit();
        Ok(Some(Buffer::from(buf)))
    }

    /// Asks the peer to stop sending, with an application error code.
    #[napi]
    pub async fn stop(&self, code: u32) -> Result<()> {
        self.0
            .lock()
            .await
            .stop(VarInt::from_u32(code))
            .map_err(js_err)
    }
}
