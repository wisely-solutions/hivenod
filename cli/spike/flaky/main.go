// flaky: a TCP forwarder that takes the network away on a schedule, for the spike's soak test.
// Two kinds of drop, alternating: "reset" closes every connection and refuses new ones; "stall"
// keeps the sockets open but stops moving bytes (a silent dead network). JSON lines on stdout.
package main

import (
	"encoding/json"
	"flag"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

func emit(f map[string]any) {
	f["t"] = time.Now().UnixMilli()
	b, _ := json.Marshal(f)
	os.Stdout.Write(append(b, '\n'))
}

type pipe struct{ a, b net.Conn }

func main() {
	listen := flag.String("listen", "127.0.0.1:18443", "")
	target := flag.String("target", "firestore.googleapis.com:443", "")
	first := flag.Duration("first", 10*time.Minute, "first drop after")
	every := flag.Duration("every", 25*time.Minute, "time between drops")
	down := flag.Duration("down", 90*time.Second, "how long the network is away")
	only := flag.String("mode", "", "reset or stall every time (default: alternate, reset first)")
	flag.Parse()

	var mu sync.Mutex
	conns := map[*pipe]bool{}
	state := "up" // up | reset | stall
	cond := sync.NewCond(&mu)

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		emit(map[string]any{"event": "fatal", "err": err.Error()})
		os.Exit(1)
	}
	emit(map[string]any{"event": "listening", "addr": *listen, "target": *target})

	go func() {
		time.Sleep(*first)
		for n := 0; ; n++ {
			mode := "reset"
			if n%2 == 1 {
				mode = "stall"
			}
			if *only != "" {
				mode = *only
			}
			mu.Lock()
			state = mode
			if mode == "reset" {
				for p := range conns {
					p.a.Close()
					p.b.Close()
				}
			}
			emit(map[string]any{"event": "down", "mode": mode, "conns": len(conns)})
			mu.Unlock()
			time.Sleep(*down)
			mu.Lock()
			if mode == "stall" {
				// After a stall the old sockets are dead for good, as after a real network change.
				for p := range conns {
					p.a.Close()
					p.b.Close()
				}
			}
			state = "up"
			cond.Broadcast()
			emit(map[string]any{"event": "up"})
			mu.Unlock()
			time.Sleep(*every)
		}
	}()

	copyGated := func(dst, src net.Conn) {
		buf := make([]byte, 32*1024)
		for {
			n, err := src.Read(buf)
			if n > 0 {
				mu.Lock()
				for state == "stall" {
					cond.Wait()
				}
				mu.Unlock()
				if _, werr := dst.Write(buf[:n]); werr != nil {
					break
				}
			}
			if err != nil {
				if err != io.EOF {
					_ = err
				}
				break
			}
		}
		dst.Close()
		src.Close()
	}

	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		mu.Lock()
		s := state
		mu.Unlock()
		if s == "reset" {
			c.Close()
			continue
		}
		if s == "stall" {
			// Hang the new connection too (as a dead network would), until it comes back.
			go func() {
				mu.Lock()
				for state == "stall" {
					cond.Wait()
				}
				mu.Unlock()
				c.Close()
			}()
			continue
		}
		go func() {
			u, err := net.DialTimeout("tcp", *target, 10*time.Second)
			if err != nil {
				c.Close()
				return
			}
			p := &pipe{c, u}
			mu.Lock()
			conns[p] = true
			mu.Unlock()
			done := make(chan struct{}, 2)
			go func() { copyGated(u, c); done <- struct{}{} }()
			go func() { copyGated(c, u); done <- struct{}{} }()
			<-done
			<-done
			mu.Lock()
			delete(conns, p)
			mu.Unlock()
		}()
	}
}
