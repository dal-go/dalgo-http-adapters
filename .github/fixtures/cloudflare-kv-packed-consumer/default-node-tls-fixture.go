// Owned default-name Cloudflare KV TLS protocol fixture. No actual Cloudflare/Workers proof.
package main

import (
 "context"
 "crypto/ecdsa"
 "crypto/elliptic"
 "crypto/rand"
 "crypto/sha256"
 "crypto/subtle"
 "crypto/tls"
 "crypto/x509"
 "crypto/x509/pkix"
 "encoding/hex"
 "encoding/json"
 "encoding/pem"
 "errors"
 "fmt"
 "io"
 "log"
 "math/big"
 "net"
 "net/http"
 "os"
 "os/signal"
 "path/filepath"
 "strings"
 "sync"
 "syscall"
 "time"
)

func writeJSON(path string, value any) error {
	data,err:=json.Marshal(value);if err!=nil{return err}
	temporary:=path+".tmp"
	if err=os.WriteFile(temporary,append(data,'\n'),0600);err!=nil{return err}
	return os.Rename(temporary,path)
}
func certificate() (tls.Certificate, []byte, error) {
	key,err:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);if err!=nil{return tls.Certificate{},nil,err}
	serial,err:=rand.Int(rand.Reader,new(big.Int).Lsh(big.NewInt(1),128));if err!=nil{return tls.Certificate{},nil,err}
	ca:=&x509.Certificate{SerialNumber:serial,Subject:pkix.Name{CommonName:"Owned KV default transport fixture CA"},NotBefore:time.Now().Add(-time.Minute),NotAfter:time.Now().Add(time.Hour),KeyUsage:x509.KeyUsageCertSign|x509.KeyUsageDigitalSignature,IsCA:true,BasicConstraintsValid:true}
	der,err:=x509.CreateCertificate(rand.Reader,ca,ca,&key.PublicKey,key);if err!=nil{return tls.Certificate{},nil,err}
	caPEM:=pem.EncodeToMemory(&pem.Block{Type:"CERTIFICATE",Bytes:der})
	parsed,err:=x509.ParseCertificate(der);if err!=nil{return tls.Certificate{},nil,err}
	serverKey,err:=ecdsa.GenerateKey(elliptic.P256(),rand.Reader);if err!=nil{return tls.Certificate{},nil,err}
	leaf:=&x509.Certificate{SerialNumber:big.NewInt(2),Subject:pkix.Name{CommonName:"Owned api.cloudflare.com KV fixture"},DNSNames:[]string{"api.cloudflare.com"},IPAddresses:[]net.IP{net.ParseIP("127.0.0.1")},NotBefore:ca.NotBefore,NotAfter:ca.NotAfter,KeyUsage:x509.KeyUsageDigitalSignature,ExtKeyUsage:[]x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},BasicConstraintsValid:true}
	leafDER,err:=x509.CreateCertificate(rand.Reader,leaf,parsed,&serverKey.PublicKey,key);if err!=nil{return tls.Certificate{},nil,err}
	keyDER,err:=x509.MarshalECPrivateKey(serverKey);if err!=nil{return tls.Certificate{},nil,err}
	cert,err:=tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type:"CERTIFICATE",Bytes:leafDER}),pem.EncodeToMemory(&pem.Block{Type:"EC PRIVATE KEY",Bytes:keyDER}))
	return cert,caPEM,err
}
func digest(data []byte) string { sum:=sha256.Sum256(data);return hex.EncodeToString(sum[:]) }

type fixtureStats struct {
 Requests int `json:"requests"`
 PointRequests int `json:"pointRequests"`
 ListRequests int `json:"listRequests"`
 AuthDenied int `json:"authDenied"`
 ProtocolFailures int `json:"protocolFailures"`
 SlowStarted int `json:"slowStarted"`
 SlowDisconnected int `json:"slowDisconnected"`
 ConnectionsOpened int `json:"connectionsOpened"`
 LiveConnections int `json:"liveConnections"`
 PeakConnections int `json:"peakConnections"`
 DataCount int `json:"dataCount"`
 DataSHA256 string `json:"dataSha256"`
}
func run() error {
 if len(os.Args)!=2||!filepath.IsAbs(os.Args[1]){return errors.New("invalid fixture directory")}
 dir:=os.Args[1];token:=os.Getenv("KV_DEFAULT_FIXTURE_TOKEN");if len(token)<24{return errors.New("invalid synthetic fixture token")}
 cert,ca,err:=certificate();if err!=nil{return err};caPath:=filepath.Join(dir,"ca.pem");if err=os.WriteFile(caPath,ca,0600);err!=nil{return err}
 data:=map[string][]byte{"tenant:a":{0,255,128},"tenant:empty":{},"tenant:🌍":{240,159,140,141}};initial,err:=json.Marshal(data);if err!=nil{return err}
 stats:=fixtureStats{DataCount:len(data),DataSHA256:digest(initial)};statsPath:=filepath.Join(dir,"stats.json");if err=writeJSON(statsPath,stats);err!=nil{return err}
 var mu sync.Mutex;var reportError error
 update:=func(change func(*fixtureStats)){mu.Lock();defer mu.Unlock();change(&stats);if err:=writeJSON(statsPath,stats);err!=nil{reportError=err}}
 stopped:=make(chan struct{})
 handler:=http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  update(func(s *fixtureStats){s.Requests++;if strings.Contains(r.URL.Path,"/values/"){s.PointRequests++}else{s.ListRequests++}})
  defer func(){_=r.Body.Close()}();body,err:=io.ReadAll(io.LimitReader(r.Body,1));bad:=func(){update(func(s *fixtureStats){s.ProtocolFailures++});w.WriteHeader(400)}
  if err!=nil||len(body)!=0||r.Method!=http.MethodGet||r.TLS==nil||r.TLS.ServerName!="api.cloudflare.com"||r.Host!="api.cloudflare.com"||r.Header.Get("Cookie")!=""||r.Header.Get("Accept-Encoding")!="identity"{bad();return}
  if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")),[]byte("Bearer "+token))!=1{update(func(s *fixtureStats){s.AuthDenied++});w.WriteHeader(403);_,_=io.WriteString(w,"PRIVATE_PROVIDER_DETAIL");return}
  const root="/client/v4/accounts/ownedaccount/storage/kv/namespaces/ownednamespace"
  write:=func(value []byte){if _,err:=w.Write(value);err!=nil&&((!errors.Is(err,syscall.EPIPE)&&!errors.Is(err,syscall.ECONNRESET))||!errors.Is(r.Context().Err(),context.Canceled)){update(func(s *fixtureStats){s.ProtocolFailures++})}}
  if strings.HasPrefix(r.URL.Path,root+"/values/"){
   if r.URL.RawQuery!=""{bad();return};key:=strings.TrimPrefix(r.URL.Path,root+"/values/")
   switch key{
   case "tenant:slow":update(func(s *fixtureStats){s.SlowStarted++});select{case<-r.Context().Done():update(func(s *fixtureStats){s.SlowDisconnected++});case<-stopped:};return
   case "tenant:oversize":w.Header().Set("Content-Type","application/octet-stream");write(make([]byte,2048));return
   case "tenant:denied":w.WriteHeader(403);write([]byte("PRIVATE_PROVIDER_DETAIL"));return
   }
   value,ok:=data[key];if !ok{w.WriteHeader(404);write([]byte("PRIVATE_PROVIDER_DETAIL"));return};w.Header().Set("Content-Type","application/octet-stream");w.Header().Set("expiration","123");write(value);return
  }
  if r.URL.Path!=root+"/keys"{bad();return};query:=r.URL.Query();if query.Get("prefix")!="tenant:"||query.Get("limit")!="10"||len(query["prefix"])!=1||len(query["limit"])!=1||len(query)>3{bad();return};w.Header().Set("Content-Type","application/json")
  switch query.Get("cursor"){
  case "":if len(query)!=2{bad();return};write([]byte(`{"success":true,"errors":[],"messages":[],"result":[],"result_info":{"count":0,"cursor":"owned-provider-page"}}`))
  case "owned-provider-page":if len(query["cursor"])!=1{bad();return};write([]byte(`{"success":true,"errors":[],"messages":[],"result":[{"name":"tenant:a","metadata":false,"expiration":123},{"name":"tenant:empty","metadata":{"nested":[true,null,3]}},{"name":"tenant:🌍"}],"result_info":{"count":3,"cursor":""}}`))
  default:bad()
  }
 })
listener,err:=net.Listen("tcp","127.0.0.1:443");if err!=nil{return err}
	defer func(){_=listener.Close()}()
	connections:=map[net.Conn]bool{}
	server:=&http.Server{Handler:handler,TLSConfig:&tls.Config{Certificates:[]tls.Certificate{cert},MinVersion:tls.VersionTLS12,NextProtos:[]string{"http/1.1"}},ReadHeaderTimeout:3*time.Second,ReadTimeout:5*time.Second,WriteTimeout:6*time.Second,IdleTimeout:2*time.Second,MaxHeaderBytes:32768,ErrorLog:log.New(io.Discard,"",0)}
	server.ConnState=func(connection net.Conn,state http.ConnState){update(func(s *fixtureStats){if state==http.StateNew{connections[connection]=true;s.ConnectionsOpened++};if state==http.StateClosed||state==http.StateHijacked{delete(connections,connection)};s.LiveConnections=len(connections);s.PeakConnections=max(s.PeakConnections,s.LiveConnections)})}
	notify,stop:=signal.NotifyContext(context.Background(),os.Interrupt,syscall.SIGTERM);defer stop()
	ctx,finish:=context.WithTimeout(notify,120*time.Second);defer finish()
	served:=make(chan error,1)
	go func(){served<-server.Serve(tls.NewListener(listener,server.TLSConfig))}()
	if err=writeJSON(filepath.Join(dir,"ready.json"),map[string]any{"endpoint":"https://api.cloudflare.com/client/v4","ca":caPath,"pid":os.Getpid()});err!=nil{_=server.Close();<-served;return err}
	select{
	case<-ctx.Done():
		close(stopped)
		shutdown,cancel:=context.WithTimeout(context.Background(),2*time.Second)
		err=server.Shutdown(shutdown);cancel()
		if err!=nil{_=server.Close()}
		serveErr:=<-served;if err==nil&&serveErr!=nil&&!errors.Is(serveErr,http.ErrServerClosed){err=serveErr}
		if errors.Is(ctx.Err(),context.DeadlineExceeded){err=context.DeadlineExceeded}
	case err=<-served:close(stopped);if errors.Is(err,http.ErrServerClosed){err=nil}
	}
	final,marshalErr:=json.Marshal(data)
	mu.Lock();defer mu.Unlock()
	if err!=nil{return err};if marshalErr!=nil{return marshalErr};if reportError!=nil{return reportError}
	if len(data)!=stats.DataCount||digest(final)!=stats.DataSHA256||stats.ProtocolFailures!=0||stats.LiveConnections!=0{return errors.New("fixture invariant failed")}
	return writeJSON(filepath.Join(dir,"closed.json"),map[string]any{"pid":os.Getpid(),"dataCount":stats.DataCount,"dataSha256":stats.DataSHA256,"liveConnections":stats.LiveConnections,"closed":true})
}
func main(){if err:=run();err!=nil{message:="owned default KV TLS fixture prerequisite or protocol failed";if errors.Is(err,syscall.EACCES){message="MISSING_GATE:port443_permission"};if errors.Is(err,syscall.EADDRINUSE){message="MISSING_GATE:port443_in_use"};_,_=fmt.Fprintln(os.Stderr,message);os.Exit(1)}}
