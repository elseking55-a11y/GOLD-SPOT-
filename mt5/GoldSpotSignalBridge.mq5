#property strict
#property version "1.0"
#property description "Gold Spot Analysis - MT5 signal monitor"
input string ApiBaseUrl="https://YOUR-RENDER-SERVICE.onrender.com";
input string AccessKey="GOLD-START-001";
input int PollSeconds=5;

string Enc(string s){
  StringReplace(s,"%","%25");
  StringReplace(s," ","%20");
  StringReplace(s,"#","%23");
  StringReplace(s,"&","%26");
  StringReplace(s,"?","%3F");
  return s;
}

string GetCommand(){
  string url=ApiBaseUrl+"/api/mt5/command?key="+Enc(AccessKey)
    +"&login="+IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN))
    +"&broker="+Enc(AccountInfoString(ACCOUNT_COMPANY))
    +"&balance="+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)
    +"&equity="+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2);
  char data[],result[]; string headers="",rh="";
  ResetLastError();
  int code=WebRequest("GET",url,"","",5000,data,0,result,rh);
  if(code==-1){
    Print("GoldSpot WebRequest error: ",GetLastError());
    return "";
  }
  return CharArrayToString(result,0,-1,CP_UTF8);
}

void ProcessSignal(string command){
  if(command=="" || command=="NOOP") return;
  Print("GoldSpot signal received: ",command);
  Print("MANUAL EXECUTION REQUIRED: review the signal and place/close the trade in MT5 yourself.");
}

int OnInit(){
  EventSetTimer(MathMax(1,PollSeconds));
  Print("GoldSpot Signal Monitor initialized.");
  Print("Add the website URL to MT5 Tools -> Options -> Expert Advisors -> allowed WebRequest URLs.");
  return INIT_SUCCEEDED;
}

void OnDeinit(const int reason){ EventKillTimer(); }
void OnTimer(){ ProcessSignal(GetCommand()); }
void OnTick(){}
