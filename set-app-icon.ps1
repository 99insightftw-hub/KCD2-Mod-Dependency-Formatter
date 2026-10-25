param([Parameter(Mandatory=$true)][string]$Exe,[Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference='Stop'
# Build-time only: update every existing Windows icon group, then verify its bytes.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AppIconResources {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string name,IntPtr file,uint flags);
 [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr h);
 delegate bool Names(IntPtr h,IntPtr type,IntPtr name,IntPtr p);
 delegate bool Languages(IntPtr h,IntPtr type,IntPtr name,ushort language,IntPtr p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool EnumResourceNames(IntPtr h,IntPtr type,Names callback,IntPtr p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool EnumResourceLanguages(IntPtr h,IntPtr type,IntPtr name,Languages callback,IntPtr p);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr BeginUpdateResource(string path,bool delete);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool UpdateResource(IntPtr h,IntPtr type,IntPtr name,ushort language,byte[] data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool EndUpdateResource(IntPtr h,bool discard);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindResourceEx(IntPtr h,IntPtr type,IntPtr name,ushort language);
 [DllImport("kernel32.dll")] static extern IntPtr LoadResource(IntPtr h,IntPtr r);
 [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr r);
 [DllImport("kernel32.dll")] static extern uint SizeofResource(IntPtr h,IntPtr r);
 class Group { public string Name; public int Id; public ushort Lang; public IntPtr Pointer {get{return Name==null?new IntPtr(Id):Marshal.StringToHGlobalUni(Name);}} }
 static void WithName(Group g,Action<IntPtr> action){IntPtr p=g.Pointer;try{action(p);}finally{if(g.Name!=null)Marshal.FreeHGlobal(p);}}
 static void Check(bool ok){if(!ok)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 static byte[] Read(IntPtr h,int type,IntPtr name,ushort lang){IntPtr r=FindResourceEx(h,new IntPtr(type),name,lang);if(r==IntPtr.Zero)throw new Exception("Missing icon resource");byte[] b=new byte[SizeofResource(h,r)];Marshal.Copy(LockResource(LoadResource(h,r)),b,0,b.Length);return b;}
 static void Equal(byte[] a,byte[] b){if(a.Length!=b.Length)throw new Exception("Icon size mismatch");for(int i=0;i<a.Length;i++)if(a[i]!=b[i])throw new Exception("Icon bytes mismatch");}
 public static string Set(string exe,string ico){
  byte[] file=File.ReadAllBytes(ico);var frames=new List<byte[]>();byte[] group;
  using(var input=new BinaryReader(new MemoryStream(file))) {
   if(input.ReadUInt16()!=0||input.ReadUInt16()!=1)throw new Exception("Invalid ICO");int count=input.ReadUInt16();
   using(var output=new MemoryStream())using(var writer=new BinaryWriter(output)) {
    writer.Write((ushort)0);writer.Write((ushort)1);writer.Write((ushort)count);
    for(int i=0;i<count;i++){byte[] head=input.ReadBytes(8);uint size=input.ReadUInt32(),offset=input.ReadUInt32();if(offset+size>file.Length)throw new Exception("Invalid icon offset");var frame=new byte[size];Array.Copy(file,offset,frame,0,size);frames.Add(frame);writer.Write(head);writer.Write(size);writer.Write((ushort)(400+i));}
    group=output.ToArray();
   }
  }
  var groups=new List<Group>();IntPtr lib=LoadLibraryEx(exe,IntPtr.Zero,2);if(lib==IntPtr.Zero)throw new Exception("Cannot inspect EXE");
  try{EnumResourceNames(lib,new IntPtr(14),(h,t,n,p)=>{long id=n.ToInt64();string name=(id>>16)==0?null:Marshal.PtrToStringUni(n);EnumResourceLanguages(h,t,n,(hh,tt,nn,l,pp)=>{groups.Add(new Group{Name=name,Id=(int)(id&65535),Lang=l});return true;},IntPtr.Zero);return true;},IntPtr.Zero);}finally{FreeLibrary(lib);}
  if(groups.Count==0)groups.Add(new Group{Id=1,Lang=0});
  IntPtr update=BeginUpdateResource(exe,false);if(update==IntPtr.Zero)throw new Exception("Cannot update EXE");bool committed=false;
  try{foreach(var g in groups){for(int i=0;i<frames.Count;i++)Check(UpdateResource(update,new IntPtr(3),new IntPtr(400+i),g.Lang,frames[i],(uint)frames[i].Length));WithName(g,n=>Check(UpdateResource(update,new IntPtr(14),n,g.Lang,group,(uint)group.Length)));}Check(EndUpdateResource(update,false));committed=true;}finally{if(!committed)EndUpdateResource(update,true);}
  lib=LoadLibraryEx(exe,IntPtr.Zero,2);if(lib==IntPtr.Zero)throw new Exception("Cannot verify EXE");
  try{foreach(var g in groups){WithName(g,n=>Equal(Read(lib,14,n,g.Lang),group));for(int i=0;i<frames.Count;i++)Equal(Read(lib,3,new IntPtr(400+i),g.Lang),frames[i]);}}finally{FreeLibrary(lib);}
  return "Verified "+groups.Count+" icon groups, "+frames.Count+" sizes each.";
 }
}
'@
[AppIconResources]::Set([IO.Path]::GetFullPath($Exe),[IO.Path]::GetFullPath($Icon))
